import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { campaigns, users } from "../src/db/repos";
import { ingestSources, loadSourceReport, groundingForRun } from "../src/grounding/report";
import { htmlToText, ingestUpload, ingestUrl, sourceExcerpt } from "../src/grounding/ingest";
import { sourceSummary } from "../src/ui/pages";

const goodText = "Migration should start with a network assessment. Check the network before moving phones.";
async function campaign(urls: string[], reference_links = "[]") {
  const user = await users.upsertByEmail(env.DB, `source-${crypto.randomUUID()}@example.com`);
  return campaigns.create(env.DB, { user_id: user.id, idea: "Explain network migration", grounding_refs: urls.map((source) => ({ kind: "url", source })), reference_links });
}
function page(url: string, status: number, text = goodText) {
  const u = new URL(url);
  fetchMock.get(u.origin).intercept({ path: u.pathname, method: "GET" }).reply(status, text, { headers: { "content-type": "text/plain" } });
}
function pdfReply(value: unknown) {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST", body: (raw) => {
    const request = JSON.parse(String(raw));
    return request.model === "gpt-6-luna" && request.reasoning.effort === "low" && request.input[0].content[0].type === "input_file"
      && request.input[0].content[0].file_data.startsWith("data:application/pdf;base64,JVBERi0");
  } }).reply(200, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("independent source recovery", () => {
  it("preserves successful sources when another is blocked and resumes without re-fetching either", async () => {
    const urls = ["https://blocked.example.test/page", "https://readable.example.test/page"];
    const c = await campaign(urls); const runId = crypto.randomUUID();
    page(urls[0]!, 403); page(urls[1]!, 200);
    expect(await ingestSources(env, c, runId)).toBe(false);
    expect(await ingestSources(env, c, runId)).toBe(true);
    expect(await ingestSources(env, c, runId)).toBe(true); // replay uses saved results
    const report = await loadSourceReport(env, runId);
    expect(report.map((item) => item.status)).toEqual(["unavailable", "loaded"]);
    expect(report[0]!.message).toContain("Upload a PDF or text copy");
    const evidence = await groundingForRun(env, c, runId);
    expect(evidence).toContain(goodText);
    expect(evidence).not.toContain("blocked.example");
    const html = sourceSummary(report);
    expect(html).toContain("1 read · 1 unavailable");
  });

  it("uses supplied reference links for evidence too and excludes stale URL documents", async () => {
    const c = await campaign([], JSON.stringify([{ url: "https://reference.example.test/new", label: "Research" }]));
    page("https://old.example.test/old", 200, "Obsolete product information that must not reach the new article.");
    await ingestUrl(env, c.id, "https://old.example.test/old");
    page("https://reference.example.test/new", 200);
    const runId = crypto.randomUUID();
    expect(await ingestSources(env, c, runId)).toBe(true);
    const evidence = await groundingForRun(env, c, runId);
    expect(evidence).toContain("reference.example.test/new");
    expect(evidence).not.toContain("Obsolete product");
  });

  it("saves unreadable source details for the readiness gate and continues when an upload is supplied", async () => {
    const c = await campaign(["https://missing.example.test/page"]);
    page("https://missing.example.test/page", 404);
    const firstRun = crypto.randomUUID();
    expect(await ingestSources(env, c, firstRun)).toBe(true);
    expect((await loadSourceReport(env, firstRun))[0]?.status).toBe("unavailable");
    await ingestUpload(env, c.id, "source.txt", goodText);
    // The earlier failed URL is preserved; the new upload makes the source set usable.
    expect(await ingestSources(env, c, firstRun)).toBe(true);
    expect(await groundingForRun(env, c, firstRun)).toContain(goodText);
  });

  it("checkpoints a transient source failure and retries on the next background delivery", async () => {
    const c = await campaign(["https://retry.example.test/page"]);
    page("https://retry.example.test/page", 503); page("https://retry.example.test/page", 200);
    const runId = crypto.randomUUID();
    await expect(ingestSources(env, c, runId)).rejects.toThrow();
    expect((await loadSourceReport(env, runId))[0]?.status).toBe("pending");
    expect(await ingestSources(env, c, runId)).toBe(true);
  });

  it("never renders source names or errors as HTML", () => {
    const html = sourceSummary([{ source: "<script>alert(1)</script>", status: "unavailable", message: '<img src=x onerror="alert(1)">' }]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("document readability and relevant evidence", () => {
  it("extracts an uploaded PDF with the Anthropic key and preserves exact source text", async () => {
    const c = await campaign([]);
    pdfReply({ markdown: goodText, complete: true });
    const bytes = new TextEncoder().encode("%PDF-1.7 test fixture");
    const result = await ingestUpload(env, c.id, "research.pdf", bytes.buffer as ArrayBuffer);
    expect(result.text).toBe(goodText);
    expect(result.doc.source).toBe("research.pdf");
  });

  it("rejects incomplete PDF extraction instead of silently dropping pages", async () => {
    const c = await campaign([]);
    pdfReply({ markdown: goodText, complete: false });
    await expect(ingestUpload(env, c.id, "research.pdf", new TextEncoder().encode("%PDF-1.7 test fixture").buffer as ArrayBuffer)).rejects.toThrow("too long to extract completely");
  });

  it("reads PDF URLs through the same extraction and redirect policy", async () => {
    const c = await campaign([]);
    fetchMock.get("https://pdf.example.test").intercept({ path: "/report", method: "GET" }).reply(200, "%PDF-1.7 test fixture", { headers: { "content-type": "application/pdf" } });
    pdfReply({ markdown: goodText, complete: true });
    expect((await ingestUrl(env, c.id, "https://pdf.example.test/report")).text).toBe(goodText);
  });

  it("selects relevant later paragraphs and removes page navigation from evidence", () => {
    const text = `${"Unrelated opening content. ".repeat(180)} Network migration requires a readiness assessment. ${"Unrelated end. ".repeat(100)}`;
    expect(sourceExcerpt(text, 2100, "network migration readiness assessment")).toContain("Network migration requires a readiness assessment.");
    const html = `<nav>Menu and cookies</nav><main><h1>Research</h1><p>${goodText}</p></main><footer>Footer</footer>`;
    expect(htmlToText(html)).toContain(goodText);
    expect(htmlToText(html)).not.toContain("Menu and cookies");
  });
});
