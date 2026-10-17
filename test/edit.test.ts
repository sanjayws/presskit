import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { users, campaigns, runs, articles } from "../src/db/repos";

const DEV = "dev@example.com"; // the DEV_AUTH_EMAIL the test worker authenticates as

async function makeReadyArticle(ownerEmail: string) {
  const u = await users.upsertByEmail(env.DB, ownerEmail);
  const c = await campaigns.create(env.DB, {
    user_id: u.id,
    idea: "x",
    grounding_refs: [],
  });
  const r = await runs.create(env.DB, c.id);
  await runs.setState(env.DB, r.id, "ready");
  const a = await articles.create(env.DB, {
    run_id: r.id,
    title: "old title",
    body_html: "<p>old</p>",
    excerpt: "e",
    slug: "old",
    meta_desc: "m",
    key_phrases: "[]",
    png_r2_key: null,
  });
  return a.id;
}

function save(id: string, body: unknown) {
  return SELF.fetch(`https://x.test/articles/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("inline article edit (WYSIWYG save)", () => {
  it("persists edits and re-sanitizes + house-styles the body", async () => {
    const id = await makeReadyArticle(DEV);
    const res = await save(id, {
      title: "New Title",
      body_html: '<p>Clean text—here</p><script>alert(1)</script><b onclick="x()">x</b>',
      meta_desc: "a description",
      excerpt: "an excerpt",
      slug: "New Slug Here",
      key_phrases: "cloud, pbx , , malaysia",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; article: { slug: string } };
    expect(body.ok).toBe(true);
    // Response returns the canonical saved article for the editor to reconcile.
    expect(body.article.slug).toBe("new-slug-here");

    const a = await articles.get(env.DB, id);
    expect(a!.title).toBe("New Title");
    // script tag removed by the allowlist sanitizer
    expect(a!.body_html).not.toContain("<script");
    expect(a!.body_html).not.toContain("onclick");
    // em-dash stripped by house style (deterministic)
    expect(a!.body_html).not.toMatch(/[—–]/);
    // slug canonicalized
    expect(a!.slug).toBe("new-slug-here");
    // key phrases trimmed, blanks dropped
    expect(JSON.parse(a!.key_phrases)).toEqual(["cloud", "pbx", "malaysia"]);
  });

  // H-01 regression guard: the exact payload the browser posts (fieldsOf) must
  // persist the BODY, not just metadata. Uses the real client key name.
  it("persists the body from the actual browser payload shape (body_html key)", async () => {
    const id = await makeReadyArticle(DEV);
    // Mirror src/ui/pages.ts fieldsOf(): body under `body_html`.
    const browserPayload = {
      body_html: "<h2>Edited heading</h2><p>New body content here.</p>",
      title: "Kept Title",
      slug: "kept-title",
      meta_desc: "m",
      excerpt: "e",
      key_phrases: "a, b",
    };
    const res = await save(id, browserPayload);
    expect(res.status).toBe(200);
    const a = await articles.get(env.DB, id);
    expect(a!.body_html).toContain("Edited heading");
    expect(a!.body_html).toContain("New body content here.");
    expect(a!.body_html).not.toContain("<p>old</p>");
  });

  it("404s a save to another user's article", async () => {
    const other = await makeReadyArticle("stranger-edit@example.com");
    const res = await save(other, { title: "hijacked" });
    expect(res.status).toBe(404);
    const a = await articles.get(env.DB, other);
    expect(a!.title).toBe("old title");
  });

  it("rejects malformed JSON", async () => {
    const id = await makeReadyArticle(DEV);
    const res = await SELF.fetch(`https://x.test/articles/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
