import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { fetchMock } from "./network";
import { unzipSync, strFromU8 } from "fflate";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { inlineImageStep, inlineKey, inlineUrl, loadInline, exportInlineHtml } from "../src/images/inline";
import { validateDiagram, renderSvgDiagram } from "../src/images/svg";
import { sanitizeHtml } from "../src/content/sanitize";
import { buildBundle } from "../src/bundle/export";

const source = "Assess the network, then run a pilot, and review the results.";
const diagram = { layout: "flow" as const, palette: "teal" as const, nodes: [
  { label: "Assess the network", detail: "", sourceQuote: source },
  { label: "run a pilot", detail: "", sourceQuote: source },
  { label: "review the results", detail: "", sourceQuote: source },
] };
const illustration = { kind: "svg", afterParagraph: 1, alt: "A practical pilot process", sourceQuote: source, prompt: "A clear process diagram showing assessment, a practical pilot and review." };
function reply(value: unknown, body?: (value: string) => boolean) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST", ...(body ? { body } : {}) })
    .reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });
}
async function fixture(format = "markdown") {
  const user = await users.upsertByEmail(env.DB, "dev@example.com");
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Explain the pilot process", grounding_refs: [], inline_image_count: 1 });
  const run = await runs.create(env.DB, campaign.id);
  const article = await articles.create(env.DB, { run_id: run.id, title: "A practical pilot", body_html: `<p>${source}</p>`, excerpt: "Practical steps", slug: "pilot-process", meta_desc: "Practical steps", key_phrases: "[]", png_r2_key: null, output_format: format });
  return { user, campaign, run, article };
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("native inline SVG diagrams", () => {
  it("grounds labels and details in exact source passages and rejects invented data", () => {
    expect(validateDiagram(diagram, source)).toEqual(diagram);
    expect(() => validateDiagram({ ...diagram, nodes: [{ ...diagram.nodes[0], label: "50% faster" }] }, source)).toThrow(/source/);
    expect(() => validateDiagram({ ...diagram, nodes: [{ ...diagram.nodes[0], detail: "guaranteed success" }] }, source)).toThrow(/source/);
    expect(() => validateDiagram({ ...diagram, nodes: [diagram.nodes[0], diagram.nodes[0]] }, source)).toThrow(/source/);
    expect(() => validateDiagram({ ...diagram, layout: "script" }, source)).toThrow(/structure/);
  });
  it("renders escaped text with no active content or external resources", () => {
    const attack = '</text><script>alert(1)</script><image href="https://example.com">';
    const svg = renderSvgDiagram({ ...diagram, nodes: [{ label: '<script>alert(1)</script>', detail: attack, sourceQuote: source }] }, attack);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/<(?:script|style|image|foreignObject|use)\b/i);
    expect(svg).not.toContain('href="');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="diagram-title"');
  });
  it("chooses SVG, checkpoints it, inserts it and exports the correct MIME and file extension", async () => {
    const f = await fixture(); reply({ images: [illustration] });
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    reply(diagram);
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    expect(await env.ASSETS.head(inlineKey(f.article.id, 1, "svg"))).toBeTruthy();
    expect(await env.ASSETS.head(inlineKey(f.article.id, 1))).toBeNull();
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(true);
    const article = (await articles.get(env.DB, f.article.id))!;
    expect(article.body_html).toContain(inlineUrl(article.id, 1, "svg"));
    expect(article.body_html).toContain('width="1200"');
    expect((await loadInline(env, article.id))?.slots[0]?.height).toBeGreaterThan(0);
    expect(await sanitizeHtml(article.body_html, article.id)).toContain(".svg");
    expect(await exportInlineHtml(env, article)).toContain("data:image/svg+xml;base64,");
    const response = await SELF.fetch(`https://x.test${inlineUrl(article.id, 1, "svg")}`);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const files = unzipSync(await buildBundle(env, article));
    expect(files["inline-1.svg"]).toBeTruthy(); expect(files["inline-1.png"]).toBeUndefined();
    expect(strFromU8(files["article.md"]!)).toContain("](inline-1.svg)");
    expect(strFromU8(files["inline-1.svg"]!)).toContain("Assess the network");
    const save = await SELF.fetch(`https://x.test/articles/${article.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body_html: article.body_html, key_phrases: "pilot" }) });
    expect(save.status).toBe(200);
    expect((await articles.get(env.DB, article.id))?.body_html).toContain(".svg");
    const other = await users.upsertByEmail(env.DB, "other-svg@example.com");
    await env.DB.prepare("UPDATE campaigns SET user_id=? WHERE id=?").bind(other.id, f.campaign.id).run();
    expect((await SELF.fetch(`https://x.test${inlineUrl(article.id, 1, "svg")}`)).status).toBe(404);
  });
  it("keeps Markdown SVG paths portable and constrains email/Word planning to PNG", async () => {
    const f = await fixture("markdown"); reply({ images: [illustration] });
    await inlineImageStep(env, f.article, f.campaign); reply(diagram);
    await inlineImageStep(env, f.article, f.campaign); await inlineImageStep(env, f.article, f.campaign);
    const article = (await articles.get(env.DB, f.article.id))!;
    const files = unzipSync(await buildBundle(env, article));
    expect(strFromU8(files["article.md"]!)).toContain("](inline-1.svg)");
    for (const format of ["email", "word"]) {
      const item = await fixture(format);
      reply({ images: [{ ...illustration, kind: "png" }] }, (body) => {
        const schema = JSON.parse(body).output_config.format.schema;
        return JSON.stringify(schema.properties.images.items.properties.kind.enum) === '["png"]';
      });
      await inlineImageStep(env, item.article, item.campaign);
      expect((await loadInline(env, item.article.id))?.slots[0]?.kind).toBe("png");
    }
  });
  it("reuses the saved specification after interrupted storage, without buying another AI call", async () => {
    const f = await fixture();
    await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`, JSON.stringify({ version: 1, baseHash: await (await import("../src/grounding/ingest")).sha256Hex(f.article.body_html), slots: [{ ...illustration, sourceText: source, diagram, state: "pending", attempts: 1 }] }));
    expect(await inlineImageStep(env, f.article, f.campaign)).toBe(false);
    expect((await loadInline(env, f.article.id))?.slots[0]?.state).toBe("ready");
  });
});
