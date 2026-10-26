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
    title: "t",
    body_html: "<p>hi</p>",
    excerpt: "e",
    slug: "t",
    meta_desc: "m",
    key_phrases: "[]",
    png_r2_key: null,
  });
  return { runId: r.id, articleId: a.id };
}

describe("tenant isolation (C-01)", () => {
  it("404s a run owned by another user", async () => {
    const other = await makeReadyArticle("stranger@example.com");
    const res = await SELF.fetch(`https://x.test/runs/${other.runId}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("404s another user's article assets and bundle", async () => {
    const other = await makeReadyArticle("stranger2@example.com");
    const png = await SELF.fetch(`https://x.test/articles/${other.articleId}/featured.png`);
    const zip = await SELF.fetch(`https://x.test/articles/${other.articleId}/bundle.zip`);
    const brief = await SELF.fetch(`https://x.test/articles/${other.articleId}/image-brief`);
    expect(png.status).toBe(404);
    expect(zip.status).toBe(404);
    expect(brief.status).toBe(404);
  });

  it("serves the caller's own run", async () => {
    const mine = await makeReadyArticle(DEV);
    const res = await SELF.fetch(`https://x.test/runs/${mine.runId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Result");
  });

  it("serves a private creative brief only to its owner", async () => {
    const mine = await makeReadyArticle(DEV);
    await env.ASSETS.put(`articles/${mine.articleId}/image-brief.json`, JSON.stringify({ prompt: "Approved labels and evidence" }), { httpMetadata: { contentType: "application/json" } });
    const res = await SELF.fetch(`https://x.test/articles/${mine.articleId}/image-brief`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ prompt: "Approved labels and evidence" });
  });
});

describe("security headers + CSP (C-02 defense-in-depth)", () => {
  it("rejects cross-origin mutations before touching campaign state", async () => {
    const res = await SELF.fetch("https://x.test/campaigns", { method: "POST", headers: { origin: "https://evil.test" }, body: "idea=x" });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin request through to normal validation", async () => {
    const form = new FormData();
    form.set("idea", "A grounded idea");
    const res = await SELF.fetch("https://x.test/campaigns", { method: "POST", headers: { origin: "https://x.test" }, body: form });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least one source URL or a readable supporting document");
  });

  it("caps request bodies before parsing large submissions", async () => {
    const res = await SELF.fetch("https://x.test/campaigns", { method: "POST", body: "x".repeat(21_000_001) });
    expect(res.status).toBe(413);
  });
  it("sets a nonce CSP and no inline handlers on the dashboard", async () => {
    const res = await SELF.fetch("https://x.test/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).not.toMatch(/onclick=/i);
  });
});
