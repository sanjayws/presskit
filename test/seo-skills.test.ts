import { stageBundle } from "../src/pipeline/run";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { SEO_SKILLS_VERSION, SEO_SKILLS_COMMIT, MAX_SEO_INSTRUCTION_CHARS, seoAgentInstructions, type SeoRole } from "../src/seo/skills";
import { articleSchemaStarter, seoDraftReview } from "../src/seo/review";
import { generateArticle, planArticle, type ArticleInput } from "../src/text/article";
import { proposeTopics } from "../src/text/topics";
import { reviewArticle, reviseArticle, type EditorialCheckpoint } from "../src/editorial/review";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { buildBundle, BUNDLE_VERSION } from "../src/bundle/export";
import { marketingSkillsFor } from "../src/marketing/skills";
import { seoSummary } from "../src/ui/pages";
import { sanitizeHtml } from "../src/content/sanitize";
import * as logging from "../src/log";
import manifest from "../vendor/claude-seo/manifest.json";

const fact = "Start with a network assessment.";
const core = { title: "Network assessment guide", body_html: `<h2>Plan the pilot</h2><p>${fact}</p>`, excerpt: "Practical network checks.", meta_desc: "Plan a practical pilot with clear network checks.", slug: "network-assessment", key_phrases: ["network assessment"] };
const { body_html: _body, ...planMetadata } = core;
const input: ArticleInput = { originalBrief: "Explain network assessment.", topicTitle: core.title, primaryKw: "network assessment", angle: "Practical", voiceProfileInstruction: "British English", maxWords: 300, groundingText: fact, groundingSources: [{ id: "S1", label: "notes.txt", body: fact }], writingMode: "article", outputFormat: "html" };
const roles: SeoRole[] = ["research", "brief", "plan", "write", "review", "revise", "images"];
function checkpoint(): EditorialCheckpoint { return { version: 1, state: "review", revision: 0, model: "claude-opus-5-5", input, core, finalMaxWords: 300, referenceLinks: [], cta: null, signature: "", report: null }; }
function review() { return { checks: { factual_accuracy: true, brief_coverage: true, section_order: true, specificity: true, readability: true }, requirements: [{ brief_quote: "network assessment", article_quote: fact, covered: true }], facts: [{ claim: fact, source_id: "S1", source_quote: fact }], issues: [] }; }
const requests: { system: string; prompt: string }[] = [];
function reply(value: unknown) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(200, (options) => {
    const request = JSON.parse(String(options.body)); requests.push({ system: request.system, prompt: request.messages[0].content });
    return { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
  });
}
beforeEach(() => { requests.length = 0; fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); vi.restoreAllMocks(); } });
async function fixture(format = "html", mode = "article") {
  const user = await users.upsertByEmail(env.DB, "dev@example.com");
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: input.originalBrief!, grounding_refs: [], article_type: mode });
  const run = await runs.create(env.DB, campaign.id);
  const article = await articles.create(env.DB, { ...core, run_id: run.id, key_phrases: JSON.stringify(core.key_phrases), png_r2_key: null, output_format: format });
  return { user, campaign, run, article };
}

describe("reviewed Claude SEO adapters", () => {
  it("pins source provenance and bounds every role without applying website SEO to fiction or messages", () => {
    vi.spyOn(logging, "logEvent").mockImplementation(() => {});
    expect(manifest.commit).toBe(SEO_SKILLS_COMMIT); expect(manifest.runtimeAdapterVersion).toBe(SEO_SKILLS_VERSION);
    expect(manifest.skills).toHaveLength(6);
    for (const role of roles) for (const outputFormat of ["html", "markdown", "word", "plain"] as const) {
      const text = seoAgentInstructions(role, { outputFormat, writingMode: "storytelling" });
      expect(text.length).toBeLessThanOrEqual(MAX_SEO_INSTRUCTION_CHARS); expect(text).toContain(SEO_SKILLS_VERSION);
      expect(text).toContain("not factual evidence");
    }
    for (const role of roles) {
      expect(seoAgentInstructions(role, { writingMode: "fiction" })).toBe("");
      for (const outputFormat of ["email", "chat", "linkedin", "social"] as const) expect(seoAgentInstructions(role, { outputFormat })).toBe("");
    }
    expect(marketingSkillsFor("article-write", { writingMode: "fiction" })).not.toContain("ai-seo");
    expect(seoAgentInstructions("review")).toContain("Do not fail the editorial checks");
    for (const role of ["__proto__", "constructor", "../../secret"]) expect(() => seoAgentInstructions(role as SeoRole)).toThrow("Unknown SEO role");
    const logs = JSON.stringify(vi.mocked(logging.logEvent).mock.calls);
    expect(logs).toContain("seo.skills"); expect(logs).not.toContain(fact);
  });
  it("reaches research, planning, short writing and whole-draft review/revision without extra calls", async () => {
    reply([1, 2, 3].map((n) => ({ title: `Pilot angle ${n}`, angle: `Direction ${n}`, summary: "Practical pilot guidance", primary_kw: "network assessment", volume: null, difficulty: null })));
    await proposeTopics(env, "Network assessment", fact);
    expect(requests.at(-1)?.system).toContain("seo-content-brief");
    const plan = { ...planMetadata, intro_goal: "Explain the useful first step.", sections: [{ heading: "Network checks", points: [fact] }, { heading: "Pilot", points: ["Plan a pilot"] }] };
    reply(plan); await planArticle(env, { ...input, maxWords: 800 });
    expect(requests.at(-1)?.system).toContain("seo-page");
    reply(core); await generateArticle(env, input);
    expect(requests.at(-1)?.system).toContain("seo-geo");
    reply(review()); expect((await reviewArticle(env, core, checkpoint())).passed).toBe(true);
    expect(requests.at(-1)?.system).toContain("SEO preferences are advisory");
    reply(core); await reviseArticle(env, checkpoint());
    expect(requests.at(-1)?.system).toContain("role: revise");
    expect(requests).toHaveLength(5);
    reply(core); await generateArticle(env, { ...input, writingMode: "fiction" });
    expect(requests.at(-1)?.system).not.toContain("Reviewed Claude SEO");
  });
  it("carries writing guidance through the opening and every long-form section", async () => {
    reply({ ...planMetadata, intro_goal: "Explain the practical first step.", sections: [{ heading: "Assessment", points: [fact] }, { heading: "Pilot", points: ["Choose a useful pilot"] }] });
    reply(`<p>${fact}</p>`); reply(`<h2>Assessment</h2><p>${fact}</p>`); reply("<h2>Pilot</h2><p>Choose a useful pilot.</p>");
    await generateArticle(env, { ...input, maxWords: 800 });
    expect(requests).toHaveLength(4);
    expect(requests.slice(1).every((request) => request.system.includes("seo-content") && request.system.includes("role: write"))).toBe(true);
  });
});

describe("non-blocking draft SEO guidance and exports", () => {
  it("provides suggestions without mutating the saved article or inventing a ranking score", async () => {
    const f = await fixture(); const article = { ...f.article, meta_desc: `${core.title}. Start free now.` };
    const review = seoDraftReview(article);
    expect(review.applicable).toBe(true);
    expect(review.checks.find((c) => c.id === "description")?.state).toBe("consider");
    expect(review).not.toHaveProperty("score"); expect(review).not.toHaveProperty("passed");
    expect(article.meta_desc).toContain("Start free now");
    const schema = articleSchemaStarter(article)!;
    expect(schema["@type"]).toBe("Article");
    for (const property of ["author", "publisher", "datePublished", "dateModified", "url", "image", "review", "aggregateRating"]) expect(schema).not.toHaveProperty(property);
    const html = seoSummary({ ...review, checks: [{ id: "test", state: "consider", label: "<script>bad</script>", advice: '<img src=x onerror="alert(1)">' }] }, article.id);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).toContain("never block generation");
  });
  it("adds a truthful schema starter/checklist to HTML exports and keeps channel/fiction exports clear", async () => {
    const f = await fixture(); const files = unzipSync(await buildBundle(env, f.article));
    expect(JSON.parse(strFromU8(files["article-schema.json"]!))).toMatchObject({ "@type": "Article", headline: core.title });
    const safeJson = unzipSync(await buildBundle(env, { ...f.article, title: "A <practical> guide" }))["article-schema.json"]!;
    expect(JSON.parse(strFromU8(safeJson)).headline).toBe("A <practical> guide");
    expect(strFromU8(safeJson)).not.toContain("<practical>");
    expect(files["seo-checklist.json"]).toBeTruthy(); expect(strFromU8(files["seo-publishing.txt"]!)).toContain("incomplete Article");
    for (const [format, mode] of [["email", "article"], ["chat", "article"], ["html", "fiction"]]) {
      const other = await fixture(format, mode); const zip = unzipSync(await buildBundle(env, other.article));
      expect(zip["article-schema.json"]).toBeUndefined(); expect(zip["seo-checklist.json"]).toBeUndefined();
    }
  });
  it("upgrades old cached ZIPs without a writing call and scopes the checklist to its owner", async () => {
    const f = await fixture(); const key = `articles/${f.article.id}/bundle.zip`;
    await env.ASSETS.put(key, new Uint8Array([1, 2, 3])); await articles.update(env.DB, f.article.id, { bundle_r2_key: key });
    const response = await SELF.fetch(`https://x.test/articles/${f.article.id}/bundle.zip`);
    expect(response.status).toBe(200); expect(unzipSync(new Uint8Array(await response.arrayBuffer()))["seo-checklist.json"]).toBeTruthy();
    // Cache upgrade uses the queued article loader rather than an old HTTP snapshot.
    await stageBundle(env, f.run.id, f.article.id);
    expect((await env.ASSETS.head(key))?.customMetadata?.bundleVersion).toBe(BUNDLE_VERSION);
    expect((await SELF.fetch(`https://x.test/articles/${f.article.id}/seo`)).status).toBe(200);
    const other = await users.upsertByEmail(env.DB, "seo-other@example.com");
    await env.DB.prepare("UPDATE campaigns SET user_id=? WHERE id=?").bind(other.id, f.campaign.id).run();
    expect((await SELF.fetch(`https://x.test/articles/${f.article.id}/seo`)).status).toBe(404);
  });
  it("preserves only valid owned image dimensions through article sanitization", async () => {
    const f = await fixture(); const source = `/articles/${f.article.id}/inline-images/1.png`;
    expect(await sanitizeHtml(`<img src="${source}" width="1536" height="1024" decoding="async">`, f.article.id)).toContain('width="1536"');
    const clean = await sanitizeHtml(`<img src="${source}" width="-2" height="90000" decoding="bad" onload="alert(1)">`, f.article.id);
    expect(clean).not.toMatch(/width=|height=|decoding=|onload=/);
  });
});
