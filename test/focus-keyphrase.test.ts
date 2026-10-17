import { beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { sanitizeKeyPhrases } from "../src/content/validate";
import { proposeTopics } from "../src/text/topics";
import { users, campaigns, runs, articles } from "../src/db/repos";
import { buildBundle } from "../src/bundle/export";

const ANTHROPIC = "https://api.anthropic.com";
const GEN_PATH = "/v1/messages";

function anthropicReply(text: string) {
  return { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("Yoast focus keyphrase: no commas anywhere", () => {
  it("the researched primary keyword is sanitized (commas/punctuation out)", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    const topics = [1, 2, 3].map((i) => ({
      title: `Title ${i}`,
      angle: `angle ${i}`,
      summary: "s",
      primary_kw: `voice ai, malaysia ${i}!`,
      volume: 100,
      difficulty: 10,
    }));
    fetchMock
      .get(ANTHROPIC)
      .intercept({ path: GEN_PATH, method: "POST" })
      .reply(200, anthropicReply(JSON.stringify(topics)));

    const out = await proposeTopics(env, "voice ai", "grounding");
    expect(out.length).toBe(3);
    for (const t of out) {
      expect(t.primary_kw).not.toContain(",");
      expect(t.primary_kw).not.toContain("!");
    }
    expect(out.map((t) => t.primary_kw)).toContain("voice ai malaysia 1");
    fetchMock.assertNoPendingInterceptors();
  });

  it("prepending the primary keyword keeps it first and dedupes the rest", () => {
    // Mirrors the stageWrite composition: [topic.primary_kw, ...plan phrases].
    const out = sanitizeKeyPhrases([
      "voice ai malaysia",
      "best voice ai tools",
      "Voice AI Malaysia", // dup of the focus phrase, different case
      "ai, agents", // comma inside one phrase is cleaned, not split
    ]);
    expect(out[0]).toBe("voice ai malaysia");
    expect(out).toContain("ai agents");
    expect(out.filter((p) => p.toLowerCase() === "voice ai malaysia")).toHaveLength(1);
    for (const p of out) expect(p).not.toContain(",");
  });

  it("bundle meta.json carries a single comma-free focus_keyphrase", async () => {
    const u = await users.upsertByEmail(env.DB, `fkp-${crypto.randomUUID()}@example.com`);
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r = await runs.create(env.DB, c.id);
    const a = await articles.create(env.DB, {
      run_id: r.id,
      title: "T",
      body_html: "<p>body</p>",
      excerpt: "e",
      slug: "t",
      meta_desc: "m",
      key_phrases: JSON.stringify(["voice ai malaysia", "ai tools"]),
      png_r2_key: null,
    });
    const entries = unzipSync(await buildBundle(env, a));
    const meta = JSON.parse(strFromU8(entries["meta.json"]!));
    expect(meta.focus_keyphrase).toBe("voice ai malaysia");
    expect(meta.focus_keyphrase).not.toContain(",");
    expect(meta.key_phrases[0]).toBe(meta.focus_keyphrase);
  });
});
