import { beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import {
  ARTICLE_TYPES,
  articleTypeByValue,
  isArticleType,
} from "../src/style/engine";
import { generateArticle } from "../src/text/article";
import { proposeTopics } from "../src/text/topics";
import { users, campaigns } from "../src/db/repos";

const ANTHROPIC = "https://api.anthropic.com";
const GEN_PATH = "/v1/messages";

function anthropicReply(text: string) {
  return { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("article types (data + guards)", () => {
  it("recognises every defined type and rejects unknown values", () => {
    for (const t of ARTICLE_TYPES) expect(isArticleType(t.value)).toBe(true);
    expect(isArticleType("poem")).toBe(false);
    expect(isArticleType("")).toBe(false);
  });

  it("falls back to the standard article for unknown/blank values", () => {
    expect(articleTypeByValue("nope").value).toBe("article");
    expect(articleTypeByValue("").value).toBe("article");
    expect(articleTypeByValue("comparison").value).toBe("comparison");
  });

  it("the standard article adds no extra guidance", () => {
    const a = articleTypeByValue("article");
    expect(a.research).toBe("");
    expect(a.writing).toBe("");
  });

  it("comparison research asks for comparative data and best-of angles", () => {
    const r = articleTypeByValue("comparison").research;
    expect(r).toContain("best X in Y");
    expect(r).toContain("competing options");
    expect(r).toContain("only with comparative evidence");
  });

  it("comparison verdict follows evidence regardless of promotional stance", () => {
    const w = articleTypeByValue("comparison").writing;
    expect(w).toContain("editorial stance");
    expect(w).toContain("verdict must follow the evidence");
    expect(w).toContain("never declare it the winner in advance");
    expect(w).toContain("Never invent competitor facts");
  });

  it("every non-standard type carries both research and writing guidance", () => {
    for (const t of ARTICLE_TYPES.filter((t) => t.value !== "article")) {
      expect(t.research.length, t.value).toBeGreaterThan(0);
      expect(t.writing.length, t.value).toBeGreaterThan(0);
      // House style: guidance strings must not smuggle em/en dashes into prompts.
      expect(t.research + t.writing).not.toMatch(/[–—]/);
    }
  });
});

describe("article type persistence (campaigns)", () => {
  it("defaults to 'article' and stores an explicit type", async () => {
    const u = await users.upsertByEmail(env.DB, `at-${crypto.randomUUID()}@example.com`);
    const c1 = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    expect((await campaigns.get(env.DB, c1.id))?.article_type).toBe("article");

    const c2 = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
      article_type: "comparison",
    });
    expect((await campaigns.get(env.DB, c2.id))?.article_type).toBe("comparison");
  });

  it("is updatable through the allowlisted update path", async () => {
    const u = await users.upsertByEmail(env.DB, `at-u-${crypto.randomUUID()}@example.com`);
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    await campaigns.update(env.DB, c.id, { article_type: "news" });
    expect((await campaigns.get(env.DB, c.id))?.article_type).toBe("news");
  });
});

describe("article type reaches the OpenAI prompts", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("topic research includes the comparison research guidance", async () => {
    const topics = [1, 2, 3].map((i) => ({
      title: `Best Voice AI in Malaysia ${i}`,
      angle: `angle ${i}`,
      summary: "s",
      primary_kw: `kw ${i}`,
      volume: 100,
      difficulty: 10,
    }));
    fetchMock
      .get(ANTHROPIC)
      .intercept({
        path: GEN_PATH,
        method: "POST",
        body: (b) => String(b).includes("Article type: COMPARISON"),
      })
      .reply(200, anthropicReply(JSON.stringify(topics)));

    const out = await proposeTopics(
      env,
      "voice ai",
      "grounding",
      articleTypeByValue("comparison").research,
    );
    expect(out.length).toBe(3);
    fetchMock.assertNoPendingInterceptors();
  });

  it("the writer prompt includes the comparison writing guidance", async () => {
    fetchMock
      .get(ANTHROPIC)
      .intercept({
        path: GEN_PATH,
        method: "POST",
        body: (b) => String(b).includes("Article type: comparison piece"),
      })
      .reply(
        200,
        anthropicReply(
          JSON.stringify({
            title: "Best Voice AI in Malaysia",
            body_html: "<p>Comparison body.</p>",
            excerpt: "e",
            meta_desc: "m",
            slug: "best-voice-ai",
            key_phrases: ["voice ai"],
          }),
        ),
      );

    const out = await generateArticle(env, {
      topicTitle: "Best Voice AI in Malaysia",
      angle: "comparison",
      primaryKw: "voice ai malaysia",
      voiceProfileInstruction: "US English.",
      maxWords: 300,
      groundingText: "[S1] our product is great",
      biasLevel: 5,
      articleTypeInstruction: articleTypeByValue("comparison").writing,
    });
    expect(out.title).toContain("Best Voice AI");
    fetchMock.assertNoPendingInterceptors();
  });
});
