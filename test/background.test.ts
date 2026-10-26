import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env, createMessageBatch } from "cloudflare:test";
import { fetchMock } from "./network";
import { users, campaigns, runs } from "../src/db/repos";
import { scheduleStage, getRecovery, recoverStalledRuns, retryInBackground, resumeSavedRun, MAX_BACKGROUND_FAILURES } from "../src/pipeline/recovery";
import { handleQueue } from "../src/pipeline/queue";
import { saveSourceUpload, sourceUploads } from "../src/grounding/uploads";
import { ingestSources, loadSourceReport, sourceReportKey } from "../src/grounding/report";
import { isTransientFailure } from "../src/errors";
import type { PipelineMessage } from "../src/env";

async function fixture() {
  const user = await users.upsertByEmail(env.DB, `bg-${crypto.randomUUID()}@example.com`);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Explain migration", grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  const send = vi.fn().mockResolvedValue(undefined);
  return { campaign, run, send, bindings: { ...env, PIPELINE: { ...env.PIPELINE, send } } };
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });

describe("durable background runs", () => {
  it("retries binding outages and preserves long upload filename extensions", async () => {
    for (const message of ["D1_ERROR: unavailable", "R2 PUT failed: 503", "Network connection lost."]) expect(isTransientFailure(new Error(message))).toBe(true);
    expect(isTransientFailure(new Error("Invalid PDF"))).toBe(false);
    const f = await fixture();
    await saveSourceUpload(env, f.campaign.id, new File(["%PDF-1.7 fixture"], "x".repeat(300) + ".pdf"));
    const upload = (await sourceUploads(env, f.campaign.id))[0]!;
    expect(upload.filename.length).toBe(240);
    expect(upload.filename.endsWith(".pdf")).toBe(true);
  });
  it("manual source retry clears failures while retaining successfully read sources", async () => {
    const f = await fixture();
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "ingest" });
    await saveSourceUpload(env, f.campaign.id, new File(["%PDF-1.7 fixture"], "source.pdf"));
    await env.DB.prepare("UPDATE source_uploads SET state='unavailable',error='temporary' WHERE campaign_id=?").bind(f.campaign.id).run();
    await env.ASSETS.put(sourceReportKey(f.run.id), JSON.stringify([{ source: "good", status: "loaded", message: "Read", docId: "retained" }, { source: "bad", status: "unavailable", message: "Blocked" }]));
    await runs.fail(env.DB, f.run.id, "source unavailable");
    expect(await resumeSavedRun(f.bindings, f.run.id)).toBe(true);
    expect(await loadSourceReport(env, f.run.id)).toHaveLength(1);
    expect((await sourceUploads(env, f.campaign.id))[0]?.state).toBe("pending");
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("drafting_topics");
  });
  it("retains delivery intent when queue send fails, then recovers without the browser", async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error("temporary queue outage"));
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "ingest" });
    expect((await getRecovery(env, f.run.id))?.stage).toBe("ingest");
    await env.DB.prepare("UPDATE run_recovery SET due_at=0 WHERE run_id=?").bind(f.run.id).run();
    await recoverStalledRuns(f.bindings);
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "ingest" });
    const count = f.send.mock.calls.length;
    await recoverStalledRuns(f.bindings);
    expect(f.send).toHaveBeenCalledTimes(count);
  });
  it("backs off persistent provider faults without discarding the run or saved work", async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) await retryInBackground(f.bindings, { runId: f.run.id, stage: "ingest" });
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("drafting_topics");
    expect((await getRecovery(env, f.run.id))?.failures).toBe(8);
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "ingest" }, { delaySeconds: 3600 });
  });
  it("bounds persistent service retries and leaves the checkpoint resumable", async () => {
    const f = await fixture();
    for (let i = 0; i <= MAX_BACKGROUND_FAILURES; i++) await retryInBackground(f.bindings, { runId: f.run.id, stage: "ingest" });
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("failed");
    expect(f.send).toHaveBeenCalledTimes(MAX_BACKGROUND_FAILURES);
    expect(await resumeSavedRun(f.bindings, f.run.id)).toBe(true);
    expect((await getRecovery(env, f.run.id))?.failures).toBe(0);
  });
  it("does not resume human selection gates, finished runs, or a live lease", async () => {
    const f = await fixture();
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "ingest" });
    const lease = await runs.claimStage(env.DB, f.run.id, "drafting_topics", 600000);
    await env.DB.prepare("UPDATE run_recovery SET due_at=0 WHERE run_id=?").bind(f.run.id).run();
    f.send.mockClear();
    await recoverStalledRuns(f.bindings);
    expect(f.send).not.toHaveBeenCalled();
    await runs.releaseStage(env.DB, f.run.id, lease!);
    for (const state of ["ready", "failed", "awaiting_topic_selection"] as const) {
      await runs.setState(env.DB, f.run.id, state);
      await recoverStalledRuns(f.bindings);
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it("stores a PDF without calling AI, then extracts it on a background delivery", async () => {
    const f = await fixture();
    await saveSourceUpload(env, f.campaign.id, new File(["%PDF-1.7 fixture"], "evidence.pdf"));
    expect((await sourceUploads(env, f.campaign.id))[0]?.state).toBe("pending");
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(503, {});
    const batch = createMessageBatch<PipelineMessage>("test", [{ id: "delivery", timestamp: new Date(), attempts: 3, body: { runId: f.run.id, stage: "ingest" } }]);
    await handleQueue(batch, f.bindings);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("drafting_topics");
    expect((await getRecovery(env, f.run.id))?.retrying).toBe(1);
    expect((await sourceUploads(env, f.campaign.id))[0]?.state).toBe("pending");
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ markdown: "A network assessment checks bandwidth and reliability before a migration.", complete: true }) }] }] });
    expect(await ingestSources(f.bindings, f.campaign, f.run.id)).toBe(false);
    expect(await ingestSources(f.bindings, f.campaign, f.run.id)).toBe(true);
    expect((await loadSourceReport(env, f.run.id))[0]?.status).toBe("loaded");
  });
});
