import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { users, campaigns, runs, topics, articles } from "../src/db/repos";

describe("campaign edit/delete repos", () => {
  it("updates campaign fields", async () => {
    const u = await users.upsertByEmail(env.DB, "edit@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "old idea",
      grounding_refs: [{ kind: "url", source: "https://a.test" }],
      persona: "professional",
      temperature: 0.6,
    });
    await campaigns.update(env.DB, c.id, {
      idea: "new idea",
      persona: "ceo",
      tone: "witty",
      temperature: 0.9,
      signature: "By X",
    });
    const back = await campaigns.get(env.DB, c.id);
    expect(back?.idea).toBe("new idea");
    expect(back?.persona).toBe("ceo");
    expect(back?.tone).toBe("witty");
    expect(back?.temperature).toBe(0.9);
    expect(back?.signature).toBe("By X");
  });

  it("cascade-deletes a campaign and its children", async () => {
    const u = await users.upsertByEmail(env.DB, "del@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
    });
    const r = await runs.create(env.DB, c.id);
    await topics.createMany(env.DB, c.id, r.id, [
      { title: "T", angle: "a", primary_kw: "k" },
    ]);
    const a = await articles.create(env.DB, {
      run_id: r.id,
      title: "t",
      body_html: "<p>x</p>",
      excerpt: "e",
      slug: "t",
      meta_desc: "m",
      key_phrases: "[]",
      png_r2_key: null,
    });

    await campaigns.remove(env.DB, c.id);

    expect(await campaigns.get(env.DB, c.id)).toBeNull();
    expect(await runs.get(env.DB, r.id)).toBeNull();
    expect(await topics.listForRun(env.DB, r.id)).toHaveLength(0);
    expect(await articles.get(env.DB, a.id)).toBeNull();
  });
});
