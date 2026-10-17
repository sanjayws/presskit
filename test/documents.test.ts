import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import { extractPptx, extractOfficeText, completeText } from "../src/grounding/documents";
import { ingestUrl, htmlToText } from "../src/grounding/ingest";
import { renderSourcePage } from "../src/grounding/browser";
import { users, campaigns } from "../src/db/repos";

const source = "A network assessment checks bandwidth and reliability before migration. Test a small pilot before moving everyone.";
function presentation() {
  return zipSync({
    "ppt/presentation.xml": strToU8('<p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst>'),
    "ppt/_rels/presentation.xml.rels": strToU8('<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>'),
    "ppt/slides/slide1.xml": strToU8('<a:p><a:r><a:t>Pilot the migration after checking your network. Keep the original system available.</a:t></a:r></a:p>'),
    "ppt/slides/slide2.xml": strToU8('<a:p><a:r><a:t>Check the </a:t></a:r><a:r><a:t>network &amp; reliability before the pilot begins.</a:t></a:r></a:p>'),
    "ppt/slides/_rels/slide2.xml.rels": strToU8('<Relationships><Relationship Id="note" Target="../notesSlides/notesSlide1.xml"/></Relationships>'),
    "ppt/notesSlides/notesSlide1.xml": strToU8('<a:p><a:r><a:t>Speaker note: do not promise savings.</a:t></a:r></a:p>'),
  });
}
describe("source document extraction", () => {
  it("preserves actual slide order, text runs and speaker notes", () => {
    const text = extractPptx(presentation());
    expect(text.indexOf("Check the network")).toBeLessThan(text.indexOf("Pilot the migration"));
    expect(text).toContain("network & reliability");
    expect(text).toContain("Speaker note: do not promise savings.");
  });
  it("rejects broken presentations, oversized inflation and silent text truncation", () => {
    expect(() => extractPptx(zipSync({ "ppt/presentation.xml": strToU8("bad") }))).toThrow("slide order");
    expect(() => extractPptx(zipSync({ "ppt/slides/slide1.xml": new Uint8Array(8_000_001) }))).toThrow("limits");
    expect(() => completeText("x".repeat(60001))).toThrow("too long");
    expect(() => htmlToText(`<main>${"x".repeat(60001)}</main>`)).toThrow("too long");
  });
  it.each(["docx", "xls", "xlsx"])("converts %s through the bound converter and retains table content", async (extension) => {
    const toMarkdown = vi.fn().mockResolvedValue({ format: "markdown", data: `## Sheet 1\n| Step | Instruction |\n| 1 | ${source} |` });
    const result = await extractOfficeText({ ...env, DOCUMENTS: Object.assign({}, env.DOCUMENTS, { toMarkdown }) }, `source.${extension}`, new Uint8Array([1, 2]));
    expect(result).toContain(source);
    expect(result).toContain("| Step | Instruction |");
    expect(toMarkdown).toHaveBeenCalledOnce();
  });
  it("refuses invalid legacy binaries instead of interpreting them as plain text", async () => {
    for (const ext of ["doc", "ppt"]) await expect(extractOfficeText(env, `source.${ext}`, new TextEncoder().encode(source))).rejects.toThrow("Office file");
  });
});

describe("browser-assisted extraction", () => {
  beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
  afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });
  it("renders a JavaScript shell, saves readable evidence and restricts browser origins", async () => {
    const user = await users.upsertByEmail(env.DB, `browser-${crypto.randomUUID()}@example.com`);
    const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Migration", grounding_refs: [] });
    const quickAction = vi.fn().mockResolvedValue(Response.json({ success: true, result: `<main><p>${source}</p></main>` }));
    const bindings = { ...env, BROWSER: Object.assign({}, env.BROWSER, { quickAction }) };
    fetchMock.get("https://public.example.test").intercept({ path: "/app", method: "GET" }).reply(200, '<div id="root"></div><script src="https://cdn.example.test/app.js"></script><script src="http://127.0.0.1/private"></script>', { headers: { "content-type": "text/html" } });
    expect((await ingestUrl(bindings, campaign.id, "https://public.example.test/app")).text).toBe(source);
    const options = quickAction.mock.calls[0]![1];
    expect(options.gotoOptions.timeout).toBe(30000);
    expect(options.allowRequestPattern).toHaveLength(2);
    expect(options.allowRequestPattern.join(" ")).not.toContain("127.0.0.1");
    await expect(renderSourcePage(bindings, "http://127.0.0.1/private")).rejects.toThrow("grounding url");
    expect(quickAction).toHaveBeenCalledOnce();
  });
});
