import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { users, campaigns } from "../src/db/repos";
import { ingestUpload } from "../src/grounding/ingest";
import { saveSourceUpload, savedSourceDocuments, sourceUploads } from "../src/grounding/uploads";
import { ingestSources, loadSourceReport } from "../src/grounding/report";

async function fixture() {
  const email = `saved-${crypto.randomUUID()}@example.com`;
  const user = await users.upsertByEmail(env.DB, email);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Explain the pilot", grounding_refs: [] });
  const bindings = { ...env, DEV_AUTH_EMAIL: email, PIPELINE: { ...env.PIPELINE, send: vi.fn().mockResolvedValue(undefined) } };
  return { campaign, bindings };
}
function submission() { const form = new FormData(); form.set("idea", "Explain a carefully staged pilot rollout."); return form; }

describe("editing saved supporting documents", () => {
  it("shows a saved upload, accepts an edit without reupload and reuses its extracted content", async () => {
    const f = await fixture();
    await saveSourceUpload(f.bindings, f.campaign.id, new File(["Start with a small pilot and evaluate call quality before expanding the deployment."], "pilot.txt"));
    const page = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/edit`), f.bindings);
    const html = await page.text();
    expect(html).toContain('data-saved-documents="1"');
    expect(html).toContain("pilot.txt"); expect(html).toContain("Waiting for extraction");
    expect(html).toContain("you do not need to upload them again");
    expect(html).toContain("60,000 characters per document"); expect(html).toContain("Maximum 12,000 characters");
    const updated = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: submission() }), f.bindings);
    expect(updated.status).toBe(302);
    expect(await sourceUploads(f.bindings, f.campaign.id)).toHaveLength(1);
    const runId = updated.headers.get("location")!.split("/").pop()!;
    const campaign = (await campaigns.get(env.DB, f.campaign.id))!;
    await ingestSources(f.bindings, campaign, runId);
    await ingestSources(f.bindings, campaign, runId);
    expect((await loadSourceReport(f.bindings, runId))[0]?.status).toBe("loaded");
    expect(await savedSourceDocuments(f.bindings, f.campaign.id)).toHaveLength(1);
  });
  it("includes legacy extracted uploads and escapes their names", async () => {
    const f = await fixture();
    await ingestUpload(f.bindings, f.campaign.id, '<img src=x onerror=alert(1)>.txt', "A phased pilot helps assess call quality and confirm support processes before rollout.");
    const page = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/edit`), f.bindings);
    const html = await page.text();
    expect(html).toContain("Ready to use"); expect(html).toContain("View extracted text");
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<img src=x");
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: submission() }), f.bindings)).status).toBe(302);
  });
  it("rejects oversized text before saving an upload, starting a run or requesting AI", async () => {
    const f = await fixture(); const form = submission();
    form.set("upload", new File(["x".repeat(60001)], "long.txt"));
    const response = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: form }), f.bindings);
    expect(response.status).toBe(400);
    expect(await sourceUploads(f.bindings, f.campaign.id)).toHaveLength(0);
    expect(f.bindings.PIPELINE.send).not.toHaveBeenCalled();
  });
  it("blocks known unreadable saved files before creating another run", async () => {
    const f = await fixture();
    await saveSourceUpload(f.bindings, f.campaign.id, new File(["A supporting document with sufficient text to pass submission validation."], "notes.txt"));
    await env.DB.prepare("UPDATE source_uploads SET state='unavailable' WHERE campaign_id=?").bind(f.campaign.id).run();
    const page = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/edit`), f.bindings);
    const html = await page.text();
    expect(html).toContain('data-saved-documents="0"'); expect(html).toContain("notes.txt");
    const response = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: submission() }), f.bindings);
    expect(response.status).toBe(400); expect(await response.text()).toContain("Saved files marked unreadable");
    expect(f.bindings.PIPELINE.send).not.toHaveBeenCalled();
  });
  it("rejects short text and invalid legacy Office files before queueing", async () => {
    const f = await fixture();
    for (const filename of ["tiny.txt", "invalid.doc", "invalid.xls", "invalid.ppt"]) {
      const form = submission(); form.set("upload", new File(["not a valid supporting file"], filename));
      const response = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: form }), f.bindings);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(filename.endsWith("txt") ? "40 readable characters" : "invalid header");
    }
    expect(await sourceUploads(f.bindings, f.campaign.id)).toHaveLength(0);
    expect(f.bindings.PIPELINE.send).not.toHaveBeenCalled();
  });
  it("does not trust a submitted saved count or expose another owner's files", async () => {
    const f = await fixture(); const form = submission(); form.set("savedDocumentCount", "1");
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: form }), f.bindings)).status).toBe(400);
    await saveSourceUpload(f.bindings, f.campaign.id, new File(["Private supporting notes covering the requested pilot rollout steps."], "private.txt"));
    const other = { ...f.bindings, DEV_AUTH_EMAIL: "other-saved@example.com" };
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/edit`), other)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: submission() }), other)).status).toBe(404);
  });
});
