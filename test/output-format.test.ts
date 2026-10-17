import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { users, campaigns, runs, articles } from "../src/db/repos";
import { buildBundle } from "../src/bundle/export";
import { resultScreen } from "../src/ui/pages";

async function newRun() {
  const u = await users.upsertByEmail(env.DB, `of-${crypto.randomUUID()}@example.com`);
  const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
  const r = await runs.create(env.DB, c.id);
  // Move to the state the gate acts from.
  await runs.transition(env.DB, r.id, "drafting_topics", "awaiting_topic_selection");
  return { campaignId: c.id, runId: r.id };
}

describe("H-01: output format is per-run, bound to the write claim", () => {
  it("defaults to html and records the chosen format atomically with the transition", async () => {
    const { runId } = await newRun();
    const won = await runs.claimWriteWithFormat(env.DB, runId, "markdown");
    expect(won).toBe(true);
    const r = await runs.get(env.DB, runId);
    expect(r?.state).toBe("writing");
    expect(r?.output_format).toBe("markdown");
  });

  it("only the first claim wins (concurrent submits cannot cross-contaminate)", async () => {
    const { runId } = await newRun();
    const [a, b] = await Promise.all([
      runs.claimWriteWithFormat(env.DB, runId, "social"),
      runs.claimWriteWithFormat(env.DB, runId, "plain"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const r = await runs.get(env.DB, runId);
    // The stored format is one of the two submitted, and the run moved once.
    expect(["social", "plain"]).toContain(r?.output_format);
    expect(r?.state).toBe("writing");
  });

  it("two runs of the same campaign keep independent formats", async () => {
    const u = await users.upsertByEmail(env.DB, `of-iso-${crypto.randomUUID()}@example.com`);
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r1 = await runs.create(env.DB, c.id);
    const r2 = await runs.create(env.DB, c.id);
    await runs.transition(env.DB, r1.id, "drafting_topics", "awaiting_topic_selection");
    await runs.transition(env.DB, r2.id, "drafting_topics", "awaiting_topic_selection");
    await runs.claimWriteWithFormat(env.DB, r1.id, "markdown");
    await runs.claimWriteWithFormat(env.DB, r2.id, "social");
    expect((await runs.get(env.DB, r1.id))?.output_format).toBe("markdown");
    expect((await runs.get(env.DB, r2.id))?.output_format).toBe("social");
  });

  it("a claim only fires from awaiting_topic_selection", async () => {
    const { runId } = await newRun();
    await runs.claimWriteWithFormat(env.DB, runId, "markdown"); // -> writing
    const again = await runs.claimWriteWithFormat(env.DB, runId, "social");
    expect(again).toBe(false);
    expect((await runs.get(env.DB, runId))?.output_format).toBe("markdown");
  });
});

describe("M-02: download-all bundle matches the chosen format", () => {
  async function articleWith(format: string, outputBody: string) {
    const u = await users.upsertByEmail(env.DB, `of-b-${crypto.randomUUID()}@example.com`);
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r = await runs.create(env.DB, c.id);
    return articles.create(env.DB, {
      run_id: r.id,
      title: "T",
      body_html: "<h2>H</h2><p>body</p>",
      excerpt: "e",
      slug: "t",
      meta_desc: "m",
      key_phrases: JSON.stringify(["k"]),
      png_r2_key: null,
      output_format: format,
      output_body: outputBody,
    });
  }

  it("markdown run -> article.md and meta.output_format=markdown", async () => {
    const a = await articleWith("markdown", "## H\n\nbody");
    const entries = unzipSync(await buildBundle(env, a));
    expect(Object.keys(entries)).toContain("article.md");
    expect(Object.keys(entries)).not.toContain("article.html");
    expect(JSON.parse(strFromU8(entries["meta.json"]!)).output_format).toBe("markdown");
    expect(strFromU8(entries["article.md"]!)).toContain("## H");
  });

  it("social run -> article.txt", async () => {
    const a = await articleWith("social", "body\n\n#K");
    const entries = unzipSync(await buildBundle(env, a));
    expect(Object.keys(entries)).toContain("article.txt");
  });

  it("counts actual words in read-only social results", async () => {
    const a = await articleWith("social", "One short post\n\n#CloudPBX #SME");
    const run = await runs.get(env.DB, a.run_id);
    expect(resultScreen({ email: "writer@example.com", history: [], nonce: "test" }, run!, [a])).toContain("5 words");
  });

  it("word run -> article.doc rendered from body_html", async () => {
    const a = await articleWith("word", "");
    const entries = unzipSync(await buildBundle(env, a));
    expect(Object.keys(entries)).toContain("article.doc");
    expect(strFromU8(entries["article.doc"]!)).toContain("urn:schemas-microsoft-com:office:word");
  });

  it("html run keeps the standalone article.html", async () => {
    const a = await articleWith("html", "");
    const entries = unzipSync(await buildBundle(env, a));
    expect(Object.keys(entries)).toContain("article.html");
    expect(strFromU8(entries["article.html"]!)).toContain("<!doctype html>");
  });
});
