import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { users, campaigns, runs, topics, articles, articleProgress } from "../src/db/repos";

async function newRun() {
  const u = await users.upsertByEmail(env.DB, `mig-${crypto.randomUUID()}@example.com`);
  const c = await campaigns.create(env.DB, {
    user_id: u.id,
    idea: "idea",
    grounding_refs: [{ kind: "url", source: "https://example.com" }],
  });
  const r = await runs.create(env.DB, c.id);
  return { campaignId: c.id, runId: r.id };
}

describe("migration 0007 schema", () => {
  it("new runs get lease/regen defaults", async () => {
    const { runId } = await newRun();
    const r = await runs.get(env.DB, runId);
    expect(r!.regen_count).toBe(0);
    expect(r!.lease_until).toBe(0);
    expect(r!.lease_owner).toBeNull();
  });

  it("article_progress round-trips and clears", async () => {
    const { runId } = await newRun();
    await articleProgress.save(env.DB, runId, "top_x", '{"a":1}', '{"sections":["<p>x</p>"]}');
    const loaded = await articleProgress.load(env.DB, runId, "top_x");
    expect(loaded!.plan_json).toBe('{"a":1}');
    await articleProgress.clearForRun(env.DB, runId);
    expect(await articleProgress.load(env.DB, runId, "top_x")).toBeNull();
  });
});

describe("atomic swaps (H-03 replace-after-success)", () => {
  it("topics.replaceForRun removes the old set and inserts the new one", async () => {
    const { campaignId, runId } = await newRun();
    await topics.replaceForRun(env.DB, campaignId, runId, [
      { title: "old", angle: "a", summary: "s", primary_kw: "k" },
    ]);
    await topics.replaceForRun(env.DB, campaignId, runId, [
      { title: "new1", angle: "a", summary: "s", primary_kw: "k" },
      { title: "new2", angle: "a", summary: "s", primary_kw: "k" },
    ]);
    const list = await topics.listForRun(env.DB, runId);
    expect(list.map((t) => t.title).sort()).toEqual(["new1", "new2"]);
  });

  it("articles.replaceForRun swaps the article set atomically", async () => {
    const { runId } = await newRun();
    const base = {
      run_id: runId,
      excerpt: "e",
      slug: "s",
      meta_desc: "m",
      key_phrases: "[]",
      png_r2_key: null,
    };
    await articles.replaceForRun(env.DB, runId, [{ ...base, title: "old", body_html: "<p>old</p>" }]);
    await articles.replaceForRun(env.DB, runId, [{ ...base, title: "new", body_html: "<p>new</p>" }]);
    const list = await articles.listForRun(env.DB, runId);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("new");
  });
});
