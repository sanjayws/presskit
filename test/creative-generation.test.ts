import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { inlineImageStep, loadInline, inlineKey, inlineUrl, exportInlineHtml } from "../src/images/inline";
import { sanitizeHtml } from "../src/content/sanitize";
import { buildBundle } from "../src/bundle/export";
import { toMarkdown } from "../src/content/render";
import { stageAutoDecide, optionJobKey, optionResultKey, recoverOptionJobs } from "../src/editorial/auto-decide";
import { creativeContextStep } from "../src/grounding/creative";
import { assessReadiness } from "../src/grounding/readiness";
import { groundingEvidenceForRun } from "../src/grounding/report";
import { QUALITY_RULES } from "../src/text/instructions";

const fact = "A careful pilot starts with a network assessment.";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";
function reply(value: unknown, body?: (body: string) => boolean) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST", ...(body ? { body } : {}) })
    .reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });
}
async function fixture(format = "html", count = 1) {
  const user = await users.upsertByEmail(env.DB, "dev@example.com");
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Explain a careful pilot", grounding_refs: [], inline_image_count: count });
  const run = await runs.create(env.DB, campaign.id);
  const article = await articles.create(env.DB, { run_id: run.id, title: "Pilot", body_html: `<p>${fact}</p><p>Choose the next useful step.</p>`, excerpt: fact, meta_desc: fact, slug: "pilot", key_phrases: "[]", png_r2_key: null, output_format: format });
  return { user, campaign, run, article };
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("inline illustrations", () => {
  it("plans, renders once, inserts in the chosen paragraph and exports portable assets", async () => {
    const f = await fixture();
    reply({ images: [{ kind: "png", afterParagraph: 1, alt: 'An illustration of a team "planning"', sourceQuote: fact, prompt: "A sculptural paper office with people thoughtfully arranging a network map." }] });
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(200, { data: [{ b64_json: png }] });
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(true);
    const article = (await articles.get(env.DB, f.article.id))!;
    expect(article.body_html.indexOf("<figure")).toBeLessThan(article.body_html.indexOf("Choose the next"));
    expect(article.body_html).toContain("&quot;planning&quot;");
    expect(article.body_html).toContain('width="1" height="1"');
    expect(article.body_html).toContain('decoding="async"');
    expect(await inlineImageStep(env, article, f.campaign)).toBe(true); // no regeneration on replay
    expect((await articles.get(env.DB, article.id))!.body_html.match(/<figure/g)).toHaveLength(1);
    expect((await loadInline(env, article.id))?.slots[0]?.state).toBe("ready");
    expect(await exportInlineHtml(env, article)).toContain("data:image/png;base64,");
    expect(toMarkdown(article.body_html)).toContain(`](${inlineUrl(article.id, 1)})`);
    const files = unzipSync(await buildBundle(env, article));
    expect(files["inline-1.png"]).toBeTruthy();
    expect(strFromU8(files["article.html"]!)).toContain('src="inline-1.png"');
    expect(strFromU8(files["article.html"]!)).not.toContain(inlineUrl(article.id, 1));
    expect((await SELF.fetch(`https://x.test${inlineUrl(article.id, 1)}`)).status).toBe(200);
    expect(await sanitizeHtml(article.body_html, article.id)).toContain("<img");
    expect(await sanitizeHtml(article.body_html)).not.toContain("<img");
    expect(await sanitizeHtml('<img src="https://tracker.example/pixel" onerror="alert(1)">', article.id)).not.toContain("<img");
  });
  it("freezes priced image options on each run and bounds planning failures", async () => {
    const f = await fixture("html", 2);
    await campaigns.update(env.DB, f.campaign.id, { inline_image_count: 3, generation_version: 2 });
    expect((await runs.get(env.DB, f.run.id))?.inline_image_count).toBe(2);
    expect((await runs.get(env.DB, f.run.id))?.generation_version).toBe(1);
    for (let n = 0; n < 3; n++) {
      fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(503, {});
      if (n < 2) await expect(inlineImageStep(env, f.article, f.campaign)).rejects.toThrow();
      else expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    }
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(true);
    expect((await loadInline(env, f.article.id))?.error).toContain("planning");
  });
  it("skips unsupported channels and bounds failures while preserving the article", async () => {
    const chat = await fixture("chat", 3);
    expect(await inlineImageStep(env, chat.article, chat.campaign)).toBe(true);
    const f = await fixture();
    reply({ images: [{ kind: "png", afterParagraph: 1, alt: "A working team", sourceQuote: fact, prompt: "An optimistic miniature office with a team planning a practical pilot project." }] });
    await inlineImageStep(env, f.article, f.campaign);
    for (let n = 0; n < 3; n++) {
      fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(503, {});
      if (n < 2) await expect(inlineImageStep(env, f.article, f.campaign)).rejects.toThrow();
      else expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    }
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(true);
    expect((await loadInline(env, f.article.id))?.slots[0]?.state).toBe("failed");
    expect((await articles.get(env.DB, f.article.id))?.body_html).toContain(fact);
  });
  it("scopes inline asset reads to the owner and rejects arbitrary paths", async () => {
    const f = await fixture(); const other = await users.upsertByEmail(env.DB, "other-inline@example.com");
    await env.DB.prepare("UPDATE campaigns SET user_id=? WHERE id=?").bind(other.id, f.campaign.id).run();
    await env.ASSETS.put(inlineKey(f.article.id, 1), new Uint8Array([1]));
    expect((await SELF.fetch(`https://x.test${inlineUrl(f.article.id, 1)}`)).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/articles/${f.article.id}/inline-images/4.png`)).status).toBe(404);
  });
});

describe("creative and fictional planning", () => {
  it("allows pure fiction without sources, while keeping facts separate from premises", async () => {
    const f = await fixture(); await campaigns.update(env.DB, f.campaign.id, { article_type: "fiction" });
    const campaign = (await campaigns.get(env.DB, f.campaign.id))!;
    expect((await assessReadiness(env, campaign, f.run.id)).state).toBe("ready");
    expect((await groundingEvidenceForRun(env, campaign, f.run.id)).sources).toEqual([]);
    reply({ needsSearch: false, query: "", scenarios: ["An invented protagonist completes a practical pilot."] });
    expect(await creativeContextStep(env, f.run.id, campaign, "")).toBeNull();
    expect(await creativeContextStep(env, f.run.id, campaign, "")).toContain("invented protagonist");
    expect(QUALITY_RULES).toContain("constructive, positive angle");
  });
  it("researches selectively, extracts a cited source, and reuses it without repeating paid steps", async () => {
    const f = await fixture(); const url = "https://public.example/pilot-guide";
    reply({ needsSearch: true, query: "practical pilot planning", scenarios: ["Illustrate a team's planning session."] });
    await creativeContextStep(env, f.run.id, f.campaign, fact);
    fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Useful planning context.", citations: [{ url, title: "Pilot guide" }] }] });
    await creativeContextStep(env, f.run.id, f.campaign, fact);
    fetchMock.get("https://public.example").intercept({ path: "/pilot-guide" }).reply(200, fact, { headers: { "content-type": "text/plain" } });
    await creativeContextStep(env, f.run.id, f.campaign, fact);
    expect(await creativeContextStep(env, f.run.id, f.campaign, fact)).toContain("Useful planning context");
    expect((await groundingEvidenceForRun(env, f.campaign, f.run.id)).sources[0]?.body).toContain(fact);
  });
});

const suggestions = { reason: "A narrative helps the reader follow practical choices.", article_type: "storytelling", output_format: "html", output_formats: ["html", "chat"], persona: "storyteller", tone: "conversational", temperature: 0.9, max_words: 800, image_style: "editorial", inline_image_count: 1, image_brief: "Optimistic paper sculpture with warm colour." };
describe("background Auto decide", () => {
  it("reads a document, suggests settings, never creates a run, and exposes the result only to its owner", async () => {
    const form = new FormData(); form.set("idea", "Explain a careful pilot through storytelling"); form.set("upload", new File([fact], "notes.txt"));
    const started = await SELF.fetch("https://x.test/brief/auto-decide", { method: "POST", body: form });
    expect(started.status).toBe(202);
    const { id } = await started.json<{ id: string }>(); const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...env, PIPELINE: { ...env.PIPELINE, send } };
    await stageAutoDecide(bindings, id); // extraction and checkpoint, no model yet
    reply(suggestions, (body) => body.includes(fact) && body.includes("never auto-submitted"));
    await stageAutoDecide(bindings, id);
    expect((await SELF.fetch(`https://x.test/brief/auto-decide/${id}`)).status).toBe(200);
    const result = await (await SELF.fetch(`https://x.test/brief/auto-decide/${id}`)).json<{ state: string; suggestions: typeof suggestions }>();
    expect(result.state).toBe("ready"); expect(result.suggestions.article_type).toBe("storytelling");
    await stageAutoDecide(bindings, id); // duplicate has no model call
    const other = await users.upsertByEmail(env.DB, "auto-other@example.com");
    await env.DB.prepare("UPDATE brief_option_jobs SET user_id=? WHERE id=?").bind(other.id, id).run();
    expect((await SELF.fetch(`https://x.test/brief/auto-decide/${id}`)).status).toBe(404);
  });
  it("reuses a saved result after an interrupted completion and bounds temporary retries", async () => {
    const user = await users.upsertByEmail(env.DB, "auto-recovery@example.com"); const id = `opt_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO brief_option_jobs(id,user_id,created_at) VALUES(?,?,?)").bind(id, user.id, Date.now()).run();
    await env.ASSETS.put(optionResultKey(id), JSON.stringify({ suggestions }));
    await stageAutoDecide(env, id);
    expect((await env.DB.prepare("SELECT state FROM brief_option_jobs WHERE id=?").bind(id).first<{ state: string }>())?.state).toBe("ready");
    const retry = `opt_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO brief_option_jobs(id,user_id,created_at) VALUES(?,?,?)").bind(retry, user.id, Date.now()).run();
    await env.ASSETS.put(optionJobKey(retry), JSON.stringify({ fields: { idea: "An optimistic fictional story" }, urls: [], text: "", read: 0, uploadDone: true, warnings: [] }));
    for (let n = 0; n < 4; n++) {
      await env.DB.prepare("UPDATE brief_option_jobs SET lease_until=0 WHERE id=?").bind(retry).run();
      fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(503, {});
      await stageAutoDecide(env, retry);
    }
    expect((await env.DB.prepare("SELECT state FROM brief_option_jobs WHERE id=?").bind(retry).first<{ state: string }>())?.state).toBe("failed");
  });
  it("rejects oversized inputs and cross-origin calls before creating a job", async () => {
    const form = new FormData(); form.set("idea", "x".repeat(12001));
    expect((await SELF.fetch("https://x.test/brief/auto-decide", { method: "POST", body: form })).status).toBe(400);
    expect((await SELF.fetch("https://x.test/brief/auto-decide", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
  it("recovers a missed queue handoff and removes expired private uploads", async () => {
    const user = await users.upsertByEmail(env.DB, "auto-expiry@example.com"); const id = `opt_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO brief_option_jobs(id,user_id,created_at) VALUES(?,?,?)").bind(id, user.id, Date.now() - 90000000).run();
    await env.ASSETS.put(optionJobKey(id), "{}"); await env.ASSETS.put(optionResultKey(id), "{}");
    const send = vi.fn().mockResolvedValue(undefined); await recoverOptionJobs({ ...env, PIPELINE: { ...env.PIPELINE, send } });
    expect(await env.ASSETS.head(optionJobKey(id))).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM brief_option_jobs WHERE id=?").bind(id).first()).toBeNull();
  });
});
