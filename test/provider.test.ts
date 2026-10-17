import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { ingestUrl } from "../src/grounding/ingest";
import { generateArticle } from "../src/text/article";
import { campaigns, users } from "../src/db/repos";
import { RetryableError } from "../src/errors";
import { generate } from "../src/anthropic/client";
import { readJsonBounded } from "../src/providers/http";

const ANTHROPIC = "https://api.anthropic.com";
const GEN_PATH = "/v1/messages";

function anthropicReply(text: string) {
  return { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
}

async function newCampaign() {
  const u = await users.upsertByEmail(env.DB, `prov-${crypto.randomUUID()}@example.com`);
  const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
  return c.id;
}

const baseInput = {
  topicTitle: "Cloud PBX",
  angle: "cost angle",
  primaryKw: "cloud pbx",
  voiceProfileInstruction: "US English.",
  groundingText: "[S1] url: https://site.test\nCloud PBX saves money and scales per seat.",
};

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.deactivate());

describe("grounding redirect policy (H-02 SSRF)", () => {
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("stores a normal 200 grounding page", async () => {
    const cid = await newCampaign();
    fetchMock
      .get("https://ok.example.test")
      .intercept({ path: "/page", method: "GET" })
      .reply(200, "This grounding page has plenty of readable text to store and use.", {
        headers: { "content-type": "text/plain" },
      });
    const { doc } = await ingestUrl(env, cid, "https://ok.example.test/page");
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a redirect that lands on a private host", async () => {
    const cid = await newCampaign();
    fetchMock
      .get("https://evil.example.test")
      .intercept({ path: "/start", method: "GET" })
      .reply(302, "", { headers: { location: "http://127.0.0.1/secret" } });
    await expect(ingestUrl(env, cid, "https://evil.example.test/start")).rejects.toThrow(
      /host not allowed/,
    );
  });

  it("follows a redirect to another public host and stores it", async () => {
    const cid = await newCampaign();
    fetchMock
      .get("https://a.example.test")
      .intercept({ path: "/1", method: "GET" })
      .reply(301, "", { headers: { location: "https://b.example.test/2" } });
    fetchMock
      .get("https://b.example.test")
      .intercept({ path: "/2", method: "GET" })
      .reply(200, "The redirected destination page has enough readable body text here.", {
        headers: { "content-type": "text/plain" },
      });
    const { text } = await ingestUrl(env, cid, "https://a.example.test/1");
    expect(text).toContain("redirected destination");
  });
});

describe("article generation provider paths (H-01)", () => {
  it("rejects malformed short articles rather than persisting bogus fields", async () => {
    for (const value of [{ title: 123, body_html: "<p>Grounded text.</p>" }, { title: "Real title", body_html: "<p></p>" }, { title: "Real title", body_html: ["not HTML"] }]) {
      fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, anthropicReply(JSON.stringify(value)));
      await expect(generateArticle(env, { ...baseInput, maxWords: 300 })).rejects.toBeInstanceOf(RetryableError);
    }
    fetchMock.assertNoPendingInterceptors();
  });
  it("short articles use a single structured call", async () => {
    fetchMock
      .get(ANTHROPIC)
      .intercept({ path: GEN_PATH, method: "POST" })
      .reply(
        200,
        anthropicReply(
          JSON.stringify({
            title: "Short One",
            body_html: "<p>A short grounded article about cloud pbx savings.</p>",
            excerpt: "e",
            meta_desc: "m",
            slug: "short-one",
            key_phrases: ["cloud pbx"],
          }),
        ),
      );
    const out = await generateArticle(env, { ...baseInput, maxWords: 300 });
    expect(out.title).toBe("Short One");
    expect(out.body_html).toContain("cloud pbx");
    fetchMock.assertNoPendingInterceptors();
  });

  it("throws retryably (never partial) when sections produce no HTML", async () => {
    // First call: a valid 2-section plan. Every later call (intro + section
    // attempts): empty output, so no section is ever completed.
    fetchMock
      .get(ANTHROPIC)
      .intercept({ path: GEN_PATH, method: "POST" })
      .reply(
        200,
        anthropicReply(
          JSON.stringify({
            title: "Long",
            slug: "long",
            meta_desc: "m",
            excerpt: "e",
            key_phrases: ["k"],
            intro_goal: "hook",
            sections: [
              { heading: "One", points: ["a", "b"] },
              { heading: "Two", points: ["c", "d"] },
            ],
          }),
        ),
      );
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, anthropicReply("<p>Opening.</p>"));
    fetchMock
      .get(ANTHROPIC)
      .intercept({ path: GEN_PATH, method: "POST" })
      .reply(200, anthropicReply("not HTML"))
      .times(2);

    await expect(generateArticle(env, { ...baseInput, maxWords: 800 })).rejects.toBeInstanceOf(
      RetryableError,
    );
  });
});

describe("Claude Opus 5.5 Messages API", () => {
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("uses the Anthropic key with low thinking and excludes reasoning from output", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST",
      headers: { "x-api-key": "test-anthropic-key", "anthropic-version": "2023-06-01" }, body: (body) => {
        const value = JSON.parse(String(body));
        return value.model === "claude-opus-5-5" && value.output_config.effort === "low" && value.thinking.type === "adaptive"
          && value.max_tokens === 3000 && !("store" in value) && !("temperature" in value) && !("top_p" in value);
      } }).reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [
        { type: "thinking", thinking: "private reasoning", signature: "opaque" },
        ...anthropicReply("Final output").content,
      ] });
    expect((await generate(env, "x", { maxOutputTokens: 3000 })).text).toBe("Final output");
  });

  it("closes nested schemas for strict structured output", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST", body: (body) => {
      const value = JSON.parse(String(body));
      const format = value.output_config.format;
      return format.type === "json_schema" && format.schema.additionalProperties === false
        && format.schema.required.join() === "rows" && format.schema.properties.rows.items.additionalProperties === false
        && format.schema.properties.rows.items.required.join() === "label";
    } }).reply(200, anthropicReply('{"rows":[]}'));
    await generate(env, "x", { responseSchema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } } } } });
  });

  it("uses bounded native web search for research", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST", body: (body) => {
      const value = JSON.parse(String(body));
      return value.tools[0].type === "web_search_20250305" && value.tools[0].max_uses === 3;
    } }).reply(200, anthropicReply("Research"));
    await generate(env, "x", { webSearch: true });
  });

  it("retries incomplete output instead of using partial text", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, {
      ...anthropicReply("partial"), stop_reason: "max_tokens",
    });
    await expect(generate(env, "x")).rejects.toBeInstanceOf(RetryableError);
  });

  it("treats refusals as permanent and does not echo provider content", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, {
      ...anthropicReply("sensitive source material"), stop_reason: "refusal",
    });
    const error = await generate(env, "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RetryableError);
    expect(String(error)).not.toContain("sensitive source");
  });

  it.each([401, 403, 404, 429, 500])("classifies access and transient failures without leaking secrets (%s)", async (status) => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(status, { private: "private source and key" });
    const error = await generate(env, "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof RetryableError).toBe(status === 429 || status === 500);
    expect(String(error)).not.toContain("private source");
    expect(String(error)).not.toContain("test-anthropic-key");
  });
});

describe("bounded provider responses", () => {
  it("checks declared and streamed sizes before parsing", async () => {
    await expect(readJsonBounded(new Response("{}", { headers: { "content-length": "100" } }), 10)).rejects.toThrow(/size limit/);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('"12345'));
      controller.enqueue(new TextEncoder().encode('67890"'));
      controller.close();
    } });
    await expect(readJsonBounded(new Response(stream), 10)).rejects.toThrow(/size limit/);
    expect(await readJsonBounded(new Response('{"ok":true}'), 20)).toEqual({ ok: true });
  });

  it("does not leak response fragments from JSON parser errors", async () => {
    const error = await readJsonBounded(new Response("private provider response"), 100).catch((e: unknown) => e);
    expect(String(error)).toContain("invalid JSON");
    expect(String(error)).not.toContain("private provider");
  });
});

describe("Anthropic continuation and validation boundaries", () => {
  it("resumes a paused search with signed content unchanged and returns only final text", async () => {
    const content = [{ type: "thinking", thinking: "private", signature: "signed-value" }, { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "question" } }, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com/source", title: "Evidence" }] }];
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, { type: "message", role: "assistant", stop_reason: "pause_turn", content });
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST", body: (raw) => {
      const body = JSON.parse(String(raw));
      return JSON.stringify(body.messages[1]) === JSON.stringify({ role: "assistant", content }) && body.tools[0].max_uses === 3;
    } }).reply(200, anthropicReply("Final answer"));
    const result = await generate(env, "Research", { webSearch: true });
    expect(result.text).toBe("Final answer");
    expect(result.sources).toContainEqual({ url: "https://example.com/source", title: "Evidence" });
    fetchMock.assertNoPendingInterceptors();
  });
  it("treats HTTP-200 search errors as failures and never switches to another provider", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST" }).reply(200, { ...anthropicReply("Incomplete answer"), content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] });
    await expect(generate(env, "Research", { webSearch: true })).rejects.toBeInstanceOf(RetryableError);
    await expect(generate({ ...env, ANTHROPIC_API_KEY: undefined }, "Draft")).rejects.toThrow("ANTHROPIC_API_KEY");
    fetchMock.assertNoPendingInterceptors();
  });
  it("adapts unsupported schema bounds for Claude but enforces them on the result", async () => {
    fetchMock.get(ANTHROPIC).intercept({ path: GEN_PATH, method: "POST", body: (raw) => {
      const schema = JSON.parse(String(raw)).output_config.format.schema;
      return schema.properties.items.maxItems === undefined && schema.properties.items.minItems === 1 && schema.additionalProperties === false;
    } }).reply(200, anthropicReply('{"items":["one","two","three"]}'));
    await expect(generate(env, "Two items", { responseSchema: { type: "object", properties: { items: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } } } } })).rejects.toBeInstanceOf(RetryableError);
    fetchMock.assertNoPendingInterceptors();
  });
});
