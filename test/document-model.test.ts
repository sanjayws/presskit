import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { fetchMock } from "./network";
import { extractDocumentMarkdown } from "../src/openai/extract";
import { users, campaigns } from "../src/db/repos";
import { ingestUpload } from "../src/grounding/ingest";
import { RetryableError } from "../src/errors";
const evidence = "Network assessment\nCheck bandwidth and reliability before the pilot. Change: -12.5%.";
const response = (markdown: string, complete = true) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ markdown, complete }) }] }] });
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });
describe("Luna document Markdown", () => {
  it("uses only Luna with the existing OpenAI key and preserves all source words and values", async () => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST", body: (raw) => {
      const request = JSON.parse(raw); return request.model === "gpt-6-luna" && request.store === false && request.reasoning.effort === "low" && request.text.format.strict;
    } }).reply(200, response("# Network assessment\n\nCheck bandwidth and reliability before the pilot. Change: -12.5%."));
    expect(await extractDocumentMarkdown(env, { filename: "source.docx", text: evidence })).toContain("# Network assessment");
  });
  it("rejects lost content, changed numeric signs, incomplete documents and provider interruption", async () => {
    for (const markdown of [evidence.replace("reliability", "availability"), evidence.replace("-12.5%", "12.5%")]) {
      fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, response(markdown));
      await expect(extractDocumentMarkdown(env, { filename: "data.xlsx", text: evidence })).rejects.toThrow("verbatim");
    }
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, response(evidence, false));
    await expect(extractDocumentMarkdown(env, { filename: "data.doc", text: evidence })).rejects.toThrow("completely");
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(503, {});
    await expect(extractDocumentMarkdown(env, { filename: "data.doc", text: evidence })).rejects.toBeInstanceOf(RetryableError);
  });
  it("lets only the source owner download the Markdown used as evidence", async () => {
    for (const [email, status] of [["dev@example.com", 200], ["other-source@example.com", 404]] as const) {
      const user = await users.upsertByEmail(env.DB, email);
      const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Source export", grounding_refs: [] });
      const { doc } = await ingestUpload(env, campaign.id, "network.txt", evidence);
      const result = await SELF.fetch(`https://x.test/sources/${doc.id}/markdown`);
      expect(result.status).toBe(status);
      if (status === 200) { expect(result.headers.get("content-disposition")).toContain(".md"); expect(result.headers.get("content-type")).toContain("text/markdown"); expect(await result.text()).toBe(evidence); }
    }
  });
  it("does not retry deterministic output-limit or content-filter failures", async () => {
    for (const reason of ["max_output_tokens", "content_filter"]) {
      fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, { status: "incomplete", incomplete_details: { reason } });
      const error = await extractDocumentMarkdown(env, { filename: "source.pdf", pdf: new TextEncoder().encode("%PDF-1.7 fixture") }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableError);
    }
  });
});
