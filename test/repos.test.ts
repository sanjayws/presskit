import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  users,
  campaigns,
  runs,
  topics,
  articles,
} from "../src/db/repos";

describe("D1 repositories round-trip (T2)", () => {
  it("upserts users idempotently by email", async () => {
    const a = await users.upsertByEmail(env.DB, "round@example.com");
    const b = await users.upsertByEmail(env.DB, "round@example.com");
    expect(a.id).toBe(b.id);
  });

  it("creates and reads a campaign with grounding refs", async () => {
    const u = await users.upsertByEmail(env.DB, "camp@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "grounded blogging",
      grounding_refs: [{ kind: "url", source: "https://x.test" }],
      max_words: 500,
    });
    const back = await campaigns.get(env.DB, c.id);
    expect(back?.idea).toBe("grounded blogging");
    expect(campaigns.refs(back!)[0]?.source).toBe("https://x.test");
    expect(back?.max_words).toBe(500);
  });

  it("advances run state and records errors", async () => {
    const u = await users.upsertByEmail(env.DB, "run@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
    });
    const r = await runs.create(env.DB, c.id);
    expect(r.state).toBe("drafting_topics");
    await runs.setState(env.DB, r.id, "writing");
    expect((await runs.get(env.DB, r.id))?.state).toBe("writing");
    await runs.fail(env.DB, r.id, "boom");
    const failed = await runs.get(env.DB, r.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toBe("boom");
  });

  it("creates topics and flips selection (T5)", async () => {
    const u = await users.upsertByEmail(env.DB, "top@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
    });
    const r = await runs.create(env.DB, c.id);
    const created = await topics.createMany(env.DB, c.id, r.id, [
      { title: "T1", angle: "a", primary_kw: "k1", volume: 100, difficulty: 20 },
      { title: "T2", angle: "b", primary_kw: "k2" },
    ]);
    expect(created).toHaveLength(2);
    await topics.select(env.DB, r.id, [created[0]!.id]);
    const selected = await topics.selectedForRun(env.DB, r.id);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.title).toBe("T1");
  });

  it("creates and updates articles (T6/T8 keys)", async () => {
    const u = await users.upsertByEmail(env.DB, "art@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
    });
    const r = await runs.create(env.DB, c.id);
    const a = await articles.create(env.DB, {
      run_id: r.id,
      title: "Title",
      body_html: "<p>hi</p><svg></svg>",
      excerpt: "e",
      slug: "title",
      meta_desc: "m",
      key_phrases: JSON.stringify(["a", "b"]),
      png_r2_key: null,
    });
    await articles.update(env.DB, a.id, {
      svg_r2_key: "svg/key",
      png_r2_key: "png/key",
    });
    const back = await articles.get(env.DB, a.id);
    expect(back?.png_r2_key).toBe("png/key");
    expect(back?.svg_r2_key).toBe("svg/key");
  });
});
