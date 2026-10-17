import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock, SELF, createMessageBatch } from "cloudflare:test";
import { users, campaigns, runs, articles } from "../src/db/repos";
import { ingestUpload } from "../src/grounding/ingest";
import { ingestSources, sourceReportKey } from "../src/grounding/report";
import { loadReadiness, readinessKey } from "../src/grounding/readiness";
import { stageAssess, stageIngest } from "../src/pipeline/run";
import { getRecovery, scheduleStage, recoverStalledRuns, resumeSavedRun, retryInBackground, advanceResearch } from "../src/pipeline/recovery";
import { handleQueue } from "../src/pipeline/queue";
import { runFailure } from "../src/ui/run-failure";
import { decideReadiness, explainReadiness } from "../src/openai/readiness";

const brief = "Explain a careful phone migration. Include the measured 40% savings.";
const fact = "Run a small pilot and retain the old system until call quality is checked.";
async function fixture(withSource = true) {
  const user = await users.upsertByEmail(env.DB, `readiness-${crypto.randomUUID()}@example.com`);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: brief, grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  if (withSource) await ingestUpload(env, campaign.id, "notes.txt", fact);
  await ingestSources(env, campaign, run.id);
  const send = vi.fn().mockResolvedValue(undefined);
  return { campaign, run, user, send, bindings: { ...env, PIPELINE: { ...env.PIPELINE, send } } };
}
function decision(choice = "ready", confidence = 0.96) {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/decisions", method: "POST", body: (body) => {
    const value = JSON.parse(String(body));
    return value.model === "gpt-6-luna" && value.questions[0].name === "readiness" && value.input.includes(fact);
  } }).reply(200, { answers: [{ type: "choice", name: "readiness", choice, confidence }] });
}
function advice(ready = false, requirement = "the measured 40% savings") {
  const value = { ready, summary: ready ? "The pilot evidence supports a practical guide." : "The pilot steps are supported, but the requested savings figure is missing.",
    gaps: ready ? [] : [{ requirement, missing: "No supplied source measures 40% savings.", action: "Upload the study and its measurement period, or remove the 40% claim from Must cover." }] };
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST", body: (body) => {
    const request = JSON.parse(String(body)); return request.store === false && request.model === "gpt-6-luna" && request.text.format.strict;
  } }).reply(200, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("readiness before writing", () => {
  it("hands ingestion to assessment instead of topic generation", async () => {
    const f = await fixture();
    await stageIngest(f.bindings, f.run.id);
    expect(f.send).toHaveBeenCalledWith({ runId: f.run.id, stage: "assess" });
  });
  it("pauses unreadable material without buying AI calls or consuming an active slot", async () => {
    const f = await fixture(false);
    await stageAssess(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("needs_input");
    expect((await loadReadiness(env, f.run.id))?.gaps[0]?.action).toContain("Upload a readable copy");
    expect(await articles.listForRun(env.DB, f.run.id)).toHaveLength(0);
    expect(await runs.activeCountsForUser(env.DB, f.user.id)).toEqual({ generating: 0, awaiting: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("proceeds from one readable source, checkpoints and does not buy a repeated check", async () => {
    const f = await fixture(); decision();
    await stageAssess(f.bindings, f.run.id);
    expect((await loadReadiness(env, f.run.id))?.state).toBe("ready");
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "topics" });
    await stageAssess(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("drafting_topics");
  });
  it("uses separate deliveries for classification and specific corrective advice, without starting a draft", async () => {
    const f = await fixture(); decision("needs_input");
    await stageAssess(f.bindings, f.run.id);
    expect((await loadReadiness(env, f.run.id))?.state).toBe("checking");
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "assess" });
    advice(); await stageAssess(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("needs_input");
    expect((await loadReadiness(env, f.run.id))?.gaps[0]?.missing).toContain("40%");
    expect(f.send.mock.calls.some(([message]) => message.stage === "write" || message.stage === "topics")).toBe(false);
    expect(await articles.listForRun(env.DB, f.run.id)).toHaveLength(0);
    await env.DB.prepare("UPDATE run_recovery SET due_at=0 WHERE run_id=?").bind(f.run.id).run();
    f.send.mockClear(); await recoverStalledRuns(f.bindings); expect(f.send).not.toHaveBeenCalled();
  });
  it("allows a closer check to overturn an uncertain preliminary classification", async () => {
    const f = await fixture(); decision("ready", 0.6); await stageAssess(f.bindings, f.run.id);
    advice(true); await stageAssess(f.bindings, f.run.id);
    expect((await loadReadiness(env, f.run.id))?.state).toBe("ready");
  });
  it("invalidates the saved assessment when the brief changes", async () => {
    const f = await fixture(); decision(); await stageAssess(f.bindings, f.run.id);
    const old = (await loadReadiness(env, f.run.id))?.fingerprint;
    await campaigns.update(env.DB, f.campaign.id, { idea: "Write a shorter pilot checklist." });
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" });
    decision(); await stageAssess(f.bindings, f.run.id);
    expect((await loadReadiness(env, f.run.id))?.fingerprint).not.toBe(old);
  });
  it("retries unavailable sources while preserving successfully read evidence", async () => {
    const f = await fixture();
    const report = await env.ASSETS.get(sourceReportKey(f.run.id));
    const saved = await report!.json<unknown[]>();
    await env.ASSETS.put(sourceReportKey(f.run.id), JSON.stringify([...saved, { source: "https://blocked.test", status: "unavailable", message: "Blocked" }]));
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" });
    await runs.setState(env.DB, f.run.id, "needs_input");
    await env.ASSETS.put(readinessKey(f.run.id), "{}");
    expect(await resumeSavedRun(f.bindings, f.run.id)).toBe(true);
    expect(await loadReadiness(env, f.run.id)).toBeNull();
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "ingest" });
  });
  it("keeps a restart paused when its transaction fails and recovers a lost queue delivery", async () => {
    const f = await fixture();
    await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" });
    await runs.setState(env.DB, f.run.id, "needs_input");
    const transaction = vi.spyOn(f.bindings.DB, "batch").mockRejectedValueOnce(new Error("D1_ERROR: interrupted"));
    try { await expect(resumeSavedRun(f.bindings, f.run.id)).rejects.toThrow("interrupted"); }
    finally { transaction.mockRestore(); }
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("needs_input");
    expect((await getRecovery(env, f.run.id))?.stage).toBe("assess");
    f.send.mockRejectedValueOnce(new Error("queue unavailable"));
    expect(await resumeSavedRun(f.bindings, f.run.id)).toBe(true);
    expect((await getRecovery(env, f.run.id))?.stage).toBe("ingest");
    await env.DB.prepare("UPDATE run_recovery SET due_at=0 WHERE run_id=?").bind(f.run.id).run();
    f.send.mockClear(); await recoverStalledRuns(f.bindings);
    expect(f.send).toHaveBeenCalledWith({ runId: f.run.id, stage: "ingest" });
  });
  it("ignores damaged readiness checkpoints and checks again", async () => {
    const f = await fixture();
    for (const damaged of ["{", "null", JSON.stringify({ version: 1, state: "needs_input", gaps: [null] })]) {
      await env.ASSETS.put(readinessKey(f.run.id), damaged);
      expect(await loadReadiness(env, f.run.id)).toBeNull();
    }
    decision(); await stageAssess(f.bindings, f.run.id);
    expect((await loadReadiness(env, f.run.id))?.state).toBe("ready");
  });
  it("preserves usage-limit guidance after background retries are exhausted", async () => {
    const f = await fixture(); await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" });
    for (let i = 0; i < 3; i++) await retryInBackground(f.bindings, { runId: f.run.id, stage: "assess" }, "OpenAI readiness 429");
    const run = await runs.get(env.DB, f.run.id);
    expect(run?.state).toBe("failed");
    expect(runFailure(run!.error).code).toBe("provider_limit");
  });
  it("never lets stale ingestion rewind an assessment", async () => {
    const f = await fixture(); await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" }); f.send.mockClear();
    await handleQueue(createMessageBatch("test", [{ id: "old", timestamp: new Date(), attempts: 1, body: { runId: f.run.id, stage: "ingest" } }]), f.bindings);
    expect((await getRecovery(env, f.run.id))?.stage).toBe("assess"); expect(f.send).not.toHaveBeenCalled();
  });
  it("persists the next intent before releasing the lease and survives a failed queue send", async () => {
    const f = await fixture(); await scheduleStage(f.bindings, { runId: f.run.id, stage: "assess" });
    const owner = await runs.claimStage(env.DB, f.run.id, "drafting_topics", 60000);
    f.send.mockImplementation(async () => {
      expect((await runs.get(env.DB, f.run.id))?.lease_owner).toBeNull();
      expect((await getRecovery(env, f.run.id))?.stage).toBe("topics");
      throw new Error("Queue unavailable");
    });
    await advanceResearch(f.bindings, f.run.id, "assess", "topics", owner!);
    expect((await getRecovery(env, f.run.id))?.stage).toBe("topics");
    const count = f.send.mock.calls.length;
    await stageIngest(f.bindings, f.run.id);
    await stageAssess(f.bindings, f.run.id);
    expect(f.send).toHaveBeenCalledTimes(count);
    expect((await getRecovery(env, f.run.id))?.stage).toBe("topics");
  });
  it("bounds readiness service retries and leaves a resumable service failure", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await retryInBackground(f.bindings, { runId: f.run.id, stage: "assess" });
    const run = await runs.get(env.DB, f.run.id);
    expect(run?.state).toBe("failed"); expect(run?.error).toContain("[assess]");
    expect(f.send).toHaveBeenCalledTimes(2);
  });
});

describe("readiness service boundaries", () => {
  it("uses structured advice when the Decisions endpoint is unavailable to the project", async () => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/decisions", method: "POST" }).reply(404, {});
    expect(await decideReadiness(env, "data")).toEqual({ choice: "explain", confidence: 0 });
  });
  it.each([401, 429, 503])("preserves HTTP %s as a service failure, not an evidence verdict", async (status) => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/decisions", method: "POST" }).reply(status, {});
    await expect(decideReadiness(env, "data")).rejects.toThrow(`(${status})`);
  });
  it("does not manufacture an evidence verdict from a refusal or malformed decision", async () => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/decisions", method: "POST" }).reply(200, { answers: [{ type: "refusal", name: "readiness" }] });
    await expect(decideReadiness(env, "data")).rejects.toThrow("declined");
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/decisions", method: "POST" }).reply(200, { answers: [{ type: "choice", name: "readiness", choice: "ready" }] });
    await expect(decideReadiness(env, "data")).rejects.toThrow("invalid decision");
  });
  it("rejects corrective advice for a requirement the user did not request", async () => {
    advice(false, "Invented requirement");
    await expect(explainReadiness(env, "data", brief)).rejects.toThrow("outside your brief");
  });
  it("keeps another user's readiness report private", async () => {
    const f = await fixture(false); await stageAssess(f.bindings, f.run.id);
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}`)).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}/resume`, { method: "POST" })).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}/recheck`, { method: "POST" })).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}/recheck`, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
  });
});
