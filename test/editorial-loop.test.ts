import { acceptanceSnapshot } from "../src/editorial/acceptance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { articles, campaigns, runs, users, topics, groundingDocs } from "../src/db/repos";
import { loadEditorial, saveEditorial, validateReview, type EditorialCheckpoint } from "../src/editorial/review";
import { stageEditorial, recheckSavedDraft, acceptSavedDraft } from "../src/pipeline/editorial";
import { stageWrite, stageImage } from "../src/pipeline/run";
import { RetryableError, StageBusyError } from "../src/errors";
import { countWords } from "../src/style/engine";
import { prepareArticle } from "../src/content/finalize";
import { getRecovery, retryInBackground } from "../src/pipeline/recovery";

const fact = "Migration should start with a network assessment.";
const core = { title: "Cloud PBX migration", body_html: `<h2>Migration</h2><p>${fact}</p>`, excerpt: fact, meta_desc: fact, slug: "cloud-pbx-migration", key_phrases: ["cloud pbx"] };
const brief = "Explain migration first. Keep the practical steps under Migration.";
function checkpoint(): EditorialCheckpoint {
  return { version: 1, state: "review", revision: 0, model: "gpt-6.1-sol", input: {
    originalBrief: brief, topicTitle: "Cloud PBX migration", angle: "Practical guide", primaryKw: "cloud pbx",
    voiceProfileInstruction: "British English", maxWords: 300,
    groundingText: `[S1] document: source.txt\n${fact}`, groundingSources: [{ id: "S1", label: "source.txt", body: fact }],
  }, core, finalMaxWords: 300, referenceLinks: [], cta: null, signature: "", report: null };
}
function review(issues: string[] = []) {
  return { checks: { factual_accuracy: true, brief_coverage: true, section_order: true, specificity: !issues.length, readability: true },
    requirements: [{ brief_quote: "Explain migration first", article_quote: fact, covered: true }, { brief_quote: "under Migration", article_quote: "Migration", covered: true }],
    facts: [{ claim: fact, source_id: "S1", source_quote: fact }], issues };
}
function reply(value: unknown, body?: (body: string) => boolean) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST", ...(body ? { body } : {}) })
    .reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
}
async function fixture() {
  const user = await users.upsertByEmail(env.DB, "dev@example.com");
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: brief, grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  await runs.setState(env.DB, run.id, "styling");
  const article = await articles.create(env.DB, { ...core, run_id: run.id, key_phrases: JSON.stringify(core.key_phrases), png_r2_key: null });
  await saveEditorial(env, article.id, checkpoint());
  const send = vi.fn().mockResolvedValue(undefined);
  return { campaign, run, article, send, bindings: { ...env, PIPELINE: { ...env.PIPELINE, send } } };
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("independent editorial loop", () => {
  it("accepts fulfilled Avoid requirements instead of falsely revising a supported draft", () => {
    const c = checkpoint(); c.input.excludeIdeas = "Do not discuss the vendor itself.";
    const raw = review();
    raw.requirements.push({ brief_quote: "Do not discuss the vendor itself.", article_quote: fact, covered: true });
    expect(validateReview(raw, core, c).passed).toBe(true);
    raw.requirements.at(-1)!.covered = false;
    expect(validateReview(raw, core, c).passed).toBe(false);
  });
  it("rechecks a failed saved draft once without restarting article generation", async () => {
    const f = await fixture(); const c = checkpoint();
    c.state = "needs_attention"; c.revision = 3; c.report = validateReview(review(["Check this passage"]), core, c);
    await saveEditorial(env, f.article.id, c); await runs.fail(env.DB, f.run.id, "Editorial review needs attention.");
    expect(await recheckSavedDraft(f.bindings, f.run.id)).toBe(true);
    expect(await recheckSavedDraft(f.bindings, f.run.id)).toBe(false);
    expect((await loadEditorial(env, f.article.id))?.state).toBe("review");
    expect((await loadEditorial(env, f.article.id))?.revision).toBe(0);
    expect((await articles.get(env.DB, f.article.id))?.body_html).toBe(core.body_html);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith({ runId: f.run.id, stage: "review" });
  });
  it("can restart a recheck interrupted after its checkpoint was saved", async () => {
    const f = await fixture(); const c = checkpoint();
    c.state = "needs_attention"; c.revision = 3; c.report = validateReview(review(["Check a passage"]), core, c);
    await saveEditorial(env, f.article.id, c); await runs.fail(env.DB, f.run.id, "Editorial review needs attention.");
    const handoff = vi.spyOn(f.bindings.DB, "batch").mockRejectedValueOnce(new Error("D1_ERROR: interrupted"));
    try { await expect(recheckSavedDraft(f.bindings, f.run.id)).rejects.toThrow("interrupted"); }
    finally { handoff.mockRestore(); }
    expect((await loadEditorial(env, f.article.id))?.state).toBe("review");
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("failed");
    expect(await recheckSavedDraft(f.bindings, f.run.id)).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("accepts exact saved exceptions without a paid call and preserves the failed report", async () => {
    const f = await fixture(); const c = checkpoint();
    c.state = "needs_attention"; c.revision = 3; c.report = validateReview(review(["Inspect this detail"]), core, c);
    await saveEditorial(env, f.article.id, c); await runs.fail(env.DB, f.run.id, "Editorial review needs attention.");
    const snapshot = await acceptanceSnapshot([{ article: f.article, checkpoint: c }]);
    expect(await acceptSavedDraft(f.bindings, f.run.id, "another-owner", snapshot)).toBe(false);
    expect(await acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, "outdated")).toBe(false);
    const html = await (await SELF.fetch(`https://x.test/runs/${f.run.id}`)).text();
    expect(html).toContain("Accept exceptions &amp; continue");
    expect(html).toContain('name="accept_exceptions" value="yes" required');
    expect(await acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, snapshot)).toBe(true);
    expect(await acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, snapshot)).toBe(false);
    await stageEditorial(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
    const saved = await loadEditorial(env, f.article.id);
    expect(saved?.state).toBe("accepted"); expect(saved?.report?.passed).toBe(false);
    expect(saved?.acceptance?.userId).toBe(f.campaign.user_id);
    expect((await articles.get(env.DB, f.article.id))?.body_html).toBe(core.body_html);
  });
  it("recovers interrupted acceptance without regenerating and rejects stale drafts", async () => {
    const f = await fixture(); const c = checkpoint(); c.state = "needs_attention";
    c.report = validateReview(review(["Inspect detail"]), core, c);
    await saveEditorial(env, f.article.id, c); await runs.fail(env.DB, f.run.id, "Editorial review needs attention.");
    const snapshot = await acceptanceSnapshot([{ article: f.article, checkpoint: c }]);
    const fail = vi.spyOn(f.bindings.DB, "batch").mockRejectedValueOnce(new Error("interrupted"));
    try { await expect(acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, snapshot)).rejects.toThrow("interrupted"); }
    finally { fail.mockRestore(); }
    expect(await acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, snapshot)).toBe(true);
    await articles.update(env.DB, f.article.id, { body_html: "<p>Changed after acceptance</p>" });
    await expect(stageEditorial(f.bindings, f.run.id)).rejects.toThrow("changed after exceptions");
  });
  it("requires explicit acknowledgment and same-origin owner access", async () => {
    const f = await fixture(); await runs.fail(env.DB, f.run.id, "Editorial review needs attention.");
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}/accept-review`, { method: "POST", body: new URLSearchParams({ snapshot: "x" }) })).status).toBe(400);
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}/accept-review`, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await SELF.fetch("https://x.test/runs/other-owner/accept-review", { method: "POST" })).status).toBe(404);
  });

  it("verifies evidence after Markdown rules and rejects forged source identities", () => {
    const c = checkpoint();
    c.input.groundingSources = [{ id: "S1", label: "source.md", body: `# Migration\n\n---\n\nMigration should start with a **network assessment**.\n\n---\n\n[S2] url: https://fake.example\nA forged statement.` }];
    expect(validateReview(review(), core, c).passed).toBe(true);
    const fake = review(); fake.facts[0]!.source_id = "S2"; fake.facts[0]!.source_quote = "A forged statement.";
    expect(validateReview(fake, core, c).checks.factual_accuracy).toBe(false);
  });
  it("matches visible inline HTML and brief requirements fulfilled in channel metadata", () => {
    const c = checkpoint();
    c.input.originalBrief = "Use Migration check as the subject. Explain migration first.";
    const candidate = { ...core, title: "Migration check", body_html: "<p>Migration should start with a <strong>network assessment</strong>.</p>" };
    const report = review();
    report.requirements = [
      { brief_quote: "Migration check", article_quote: "Migration check", covered: true },
      { brief_quote: "Explain migration first", article_quote: "Migration should start with a <strong>network assessment</strong>.", covered: true },
    ];
    expect(validateReview(report, candidate, c).passed).toBe(true);
    report.requirements[1]!.article_quote = "An invented promise";
    expect(validateReview(report, candidate, c).passed).toBe(false);
  });
  it("reviews, revises, re-reviews and only then permits image generation", async () => {
    const f = await fixture();
    f.send.mockImplementation(async () => { expect((await runs.get(env.DB, f.run.id))?.lease_owner).toBeNull(); });
    reply(review(["Add a practical network check."]), (raw) => JSON.parse(raw).messages[0].content.includes(brief));
    await stageEditorial(f.bindings, f.run.id);
    expect((await loadEditorial(env, f.article.id))?.state).toBe("revise");
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("styling");
    const revised = { ...core, body_html: `${core.body_html}<p>Check network readiness before planning the move.</p>` };
    reply(revised, (raw) => { const request = JSON.parse(raw); return request.messages[0].content.includes("Add a practical network check.") && request.messages[0].content.includes(brief); });
    await stageEditorial(f.bindings, f.run.id);
    expect((await loadEditorial(env, f.article.id))?.state).toBe("review");
    expect((await loadEditorial(env, f.article.id))?.revision).toBe(1);
    expect(f.send.mock.calls.every(([message]) => message.stage === "review")).toBe(true);
    reply(review(), (raw) => JSON.parse(raw).messages[0].content.includes("Check network readiness"));
    await stageEditorial(f.bindings, f.run.id);
    expect((await loadEditorial(env, f.article.id))?.state).toBe("passed");
    await stageEditorial(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "image" });
    expect((await articles.get(env.DB, f.article.id))?.body_html).toContain("Check network readiness");
    // A replay after the transition repairs the hand-off without another paid review.
    await stageEditorial(f.bindings, f.run.id);
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "image" });
    await retryInBackground(f.bindings, { runId: f.run.id, stage: "image" });
    const count = f.send.mock.calls.length;
    await stageEditorial(f.bindings, f.run.id);
    expect(f.send).toHaveBeenCalledTimes(count);
    expect((await getRecovery(env, f.run.id))?.failures).toBe(1);
  });

  it("stops after three revisions, keeps the latest draft and shows actionable findings", async () => {
    const f = await fixture();
    for (let round = 0; round <= 3; round++) {
      reply(review(["The requested section order is still wrong."]));
      await stageEditorial(f.bindings, f.run.id);
      if (round < 3) { reply(core); await stageEditorial(f.bindings, f.run.id); }
    }
    const saved = await loadEditorial(env, f.article.id);
    expect(saved?.state).toBe("needs_attention");
    expect(saved?.revision).toBe(3);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("failed");
    expect(f.send.mock.calls.some(([message]) => message.stage === "image")).toBe(false);
    await stageEditorial(f.bindings, f.run.id); // no more paid calls after stopping
    const page = await SELF.fetch(`https://x.test/runs/${f.run.id}`);
    const html = await page.text();
    expect(html).toContain("Editorial review needs your attention");
    expect(html).toContain("The requested section order is still wrong.");
    expect(html).toContain(`/articles/${f.article.id}/output`);
  });

  it("reviews every destination before asking for exceptions", async () => {
    const f = await fixture(); const c = checkpoint(); c.state = "needs_attention"; c.revision = 3;
    c.report = validateReview(review(["Inspect first destination"]), core, c); await saveEditorial(env, f.article.id, c);
    const second = await articles.create(env.DB, { ...core, run_id: f.run.id, key_phrases: "[]", png_r2_key: null, output_format: "email" });
    await saveEditorial(env, second.id, checkpoint());
    reply(review()); await stageEditorial(f.bindings, f.run.id);
    expect((await loadEditorial(env, second.id))?.state).toBe("passed");
    await stageEditorial(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("failed");
    const snapshot = await acceptanceSnapshot(await Promise.all((await articles.listForRun(env.DB, f.run.id)).map(async (article) => ({ article, checkpoint: await loadEditorial(env, article.id) }))));
    expect(await acceptSavedDraft(f.bindings, f.run.id, f.campaign.user_id, snapshot)).toBe(true);
    await stageEditorial(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
  });

  it("finishes multi-channel assets one per delivery and never retries a terminal image failure", async () => {
    const f = await fixture(); await runs.setState(env.DB, f.run.id, "asset_gen");
    const second = await articles.create(env.DB, { ...core, run_id: f.run.id, key_phrases: "[]", png_r2_key: null, output_format: "chat" });
    const bindings = { ...f.bindings, OPENAI_API_KEY: undefined };
    await stageImage(bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
    await stageImage(bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
    await stageImage(bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("ready");
    expect((await articles.get(env.DB, second.id))?.bundle_r2_key).toBeTruthy();
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it("does not consume a revision for provider failure, contention or a failed hand-off", async () => {
    const f = await fixture();
    const owner = await runs.claimStage(env.DB, f.run.id, "styling", 180000);
    await expect(stageEditorial(f.bindings, f.run.id)).rejects.toBeInstanceOf(StageBusyError);
    await runs.releaseStage(env.DB, f.run.id, owner!);
    fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(503, {});
    await expect(stageEditorial(f.bindings, f.run.id)).rejects.toBeInstanceOf(RetryableError);
    expect((await loadEditorial(env, f.article.id))?.revision).toBe(0);
    reply(review());
    f.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await stageEditorial(f.bindings, f.run.id); // durable hand-off survives a queue send failure
    expect((await loadEditorial(env, f.article.id))?.state).toBe("passed");
    await stageEditorial(f.bindings, f.run.id); // persists approval before hand-off, no second review
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("asset_gen");
  });

  it("exposes review progress only to the run owner", async () => {
    const f = await fixture();
    const c = checkpoint(); c.revision = 2; c.state = "revise"; await saveEditorial(env, f.article.id, c);
    expect(await (await SELF.fetch(`https://x.test/runs/${f.run.id}/status`)).json()).toEqual({ state: "styling", editorial: { state: "revise", revision: 2 } });
    const other = await users.upsertByEmail(env.DB, `other-${crypto.randomUUID()}@example.com`);
    const campaign = await campaigns.create(env.DB, { user_id: other.id, idea: "private", grounding_refs: [] });
    const run = await runs.create(env.DB, campaign.id);
    expect((await SELF.fetch(`https://x.test/runs/${run.id}/status`)).status).toBe(404);
  });
});

describe("approval requires verifiable review evidence", () => {
  it("rejects invented source quotes, missing requested points and false section-order approval", () => {
    const invented = review(); invented.facts[0]!.source_quote = "An invented quote that the source does not contain.";
    expect(validateReview(invented, core, checkpoint()).passed).toBe(false);
    const missing = review(); missing.requirements[0]!.covered = false;
    expect(validateReview(missing, core, checkpoint()).checks.brief_coverage).toBe(false);
    const misplaced = review(); misplaced.checks.section_order = false;
    expect(validateReview(misplaced, core, checkpoint()).passed).toBe(false);
    const fakePassage = review(); fakePassage.requirements[0]!.article_quote = "This was never written.";
    expect(validateReview(fakePassage, core, checkpoint()).passed).toBe(false);
    expect(validateReview(review(), core, checkpoint()).passed).toBe(true);
  });

  it("preserves the ending of an oversized article and requires a complete tightening pass", async () => {
    const c = checkpoint();
    const large = { ...core, body_html: `${core.body_html}<p>${"Detailed explanation. ".repeat(200)}</p><h2>Required ending</h2><p>Never discard this point.</p>` };
    const prepared = await prepareArticle(large, c);
    expect(countWords(prepared.body_html)).toBeGreaterThan(c.finalMaxWords);
    expect(prepared.body_html).toContain("Never discard this point.");
    const report = validateReview(review(), prepared, c);
    expect(report.passed).toBe(false);
    expect(report.issues.join()).toContain("tightening every section");
  });
});

describe("resumable detailed-brief writing", () => {
  it("writes two channel-specific drafts with shared evidence and independent resumable checkpoints", async () => {
    const f = await fixture(); await articles.replaceForRun(env.DB, f.run.id, []);
    await campaigns.update(env.DB, f.campaign.id, { max_words: 220 });
    await runs.setState(env.DB, f.run.id, "awaiting_topic_selection");
    await runs.claimWriteWithFormat(env.DB, f.run.id, "html", ["html", "chat"]);
    const doc = await groundingDocs.create(env.DB, { campaign_id: f.campaign.id, kind: "upload", source: "source.txt", r2_key: `grounding/${f.campaign.id}/source`, hash: crypto.randomUUID() });
    await env.ASSETS.put(doc.r2_key, fact);
    const selected = await topics.createMany(env.DB, f.campaign.id, f.run.id, [{ title: core.title, angle: "Guide", primary_kw: "cloud pbx" }]);
    await topics.select(env.DB, f.run.id, [selected[0]!.id]);
    reply(core, (body) => body.includes("html"));
    await stageWrite(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("writing");
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "write" });
    const message = { ...core, title: "Migration reminder", body_html: `<p><strong>Start here:</strong> ${fact}</p>` };
    reply(message, (body) => body.includes("chat"));
    await stageWrite(f.bindings, f.run.id);
    const list = await articles.listForRun(env.DB, f.run.id);
    expect(list).toHaveLength(2);
    expect(list.find((a) => a.output_format === "html")?.body_html).toContain("<h2>");
    expect(list.find((a) => a.output_format === "chat")?.output_body).toContain("*Start here:*");
    const reviews = await Promise.all(list.map((a) => loadEditorial(env, a.id)));
    expect(new Set(reviews.map((c) => c?.input.progressKey?.topicId)).size).toBe(2);
    expect(reviews.find((c) => c?.input.outputFormat === "chat")?.finalMaxWords).toBeLessThan(220);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("styling");
  });
  it("checkpoints one planned writing step per delivery and carries the full brief into every call", async () => {
    const f = await fixture();
    await articles.replaceForRun(env.DB, f.run.id, []);
    await runs.setState(env.DB, f.run.id, "writing");
    const doc = await groundingDocs.create(env.DB, { campaign_id: f.campaign.id, kind: "upload", source: "source.txt", r2_key: `grounding/${f.campaign.id}/source`, hash: crypto.randomUUID() });
    await env.ASSETS.put(doc.r2_key, fact);
    const selected = await topics.createMany(env.DB, f.campaign.id, f.run.id, [{ title: core.title, angle: "Guide", primary_kw: "cloud pbx" }]);
    await topics.select(env.DB, f.run.id, [selected[0]!.id]);
    const responses = [
      { title: core.title, slug: core.slug, meta_desc: core.meta_desc, excerpt: core.excerpt, key_phrases: core.key_phrases, intro_goal: "Answer the question", sections: [{ heading: "Migration", points: [fact] }, { heading: "Practical steps", points: ["Network assessment"] }] },
      `<p>${fact}</p>`, `<h2>Migration</h2><p>${fact}</p>`, "<h2>Practical steps</h2><p>Start with network assessment.</p>",
    ];
    for (let i = 0; i < responses.length; i++) {
      reply(responses[i], (raw) => JSON.parse(raw).messages[0].content.includes(brief));
      await stageWrite(f.bindings, f.run.id);
      fetchMock.assertNoPendingInterceptors();
      if (i < responses.length - 1) {
        expect((await articles.listForRun(env.DB, f.run.id))).toHaveLength(0);
        expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "write" });
      }
    }
    const completed = await articles.listForRun(env.DB, f.run.id);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.body_html).toContain("Practical steps");
    expect((await loadEditorial(env, completed[0]!.id))?.input.originalBrief).toBe(brief);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("styling");
    await stageWrite(f.bindings, f.run.id); // recover post-write hand-off without rewriting
    expect(f.send).toHaveBeenLastCalledWith({ runId: f.run.id, stage: "review" });
  });
});
