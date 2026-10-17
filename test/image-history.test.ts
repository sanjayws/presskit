import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import worker from "../src/index";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { imageJobs } from "../src/db/image-jobs";
import { imageVersionKey, listImageVersions } from "../src/images/history";

async function fixture(email = "dev@example.com") {
  const user = await users.upsertByEmail(env.DB, email);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "History", grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  await runs.setState(env.DB, run.id, "ready");
  const article = await articles.create(env.DB, { run_id: run.id, title: '<test> "Title"', body_html: "<p>Saved article</p>", excerpt: "e", slug: "history", meta_desc: "m", key_phrases: "[]", png_r2_key: null });
  return { article, run, campaign };
}

describe("retained image history", () => {
  it("discovers pre-existing original and superseded jobs with private, stable downloads", async () => {
    const { article, run } = await fixture();
    const ids = ["original", `img_${"a".repeat(32)}`, `img_${"b".repeat(32)}`];
    for (const id of ids) {
      const key = imageVersionKey(article.id, id)!;
      await env.ASSETS.put(key, `PNG ${id}`, { httpMetadata: { contentType: "image/png" } });
      await env.ASSETS.put(key.replace("featured.png", "image-brief.json"), JSON.stringify({ version: id }));
    }
    await articles.update(env.DB, article.id, { png_r2_key: imageVersionKey(article.id, ids[2]!)! });
    const before = await articles.get(env.DB, article.id);
    const response = await SELF.fetch(`https://x.test/articles/${article.id}/images`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const gallery = await response.json() as { count: number; version: string; html: string };
    expect(gallery.count).toBe(3);
    expect(gallery.version).toBe(ids[2]);
    expect(gallery.html).toContain("Saved images (2)");
    expect(gallery.html.indexOf(`data-image-version-card="${ids[2]}"`)).toBeLessThan(gallery.html.indexOf('data-image-version-card="original"'));
    expect(gallery.html).toContain("&lt;test&gt; &quot;Title&quot;");
    for (const id of ids) {
      const image = await SELF.fetch(`https://x.test/articles/${article.id}/images/${id}/featured.png`);
      expect(image.status).toBe(200);
      expect(image.headers.get("cache-control")).toBe("no-store");
      expect(image.headers.get("content-disposition")).toContain(`history-${id}.png`);
      expect(await image.text()).toBe(`PNG ${id}`);
      const brief = await SELF.fetch(`https://x.test/articles/${article.id}/images/${id}/image-brief`);
      expect(await brief.json()).toEqual({ version: id });
    }
    const page = await (await SELF.fetch(`https://x.test/runs/${run.id}`)).text();
    expect(page).toContain(gallery.html);
    expect(await articles.get(env.DB, article.id)).toEqual(before);
    expect(await imageJobs.get(env.DB, article.id)).toBeNull();
  });

  it("returns a different status version after a replacement, even once its job row is superseded", async () => {
    const { article } = await fixture();
    await articles.update(env.DB, article.id, { png_r2_key: imageVersionKey(article.id, "original")! });
    const first = await (await SELF.fetch(`https://x.test/articles/${article.id}/image-status`)).json() as { version: string; revision: string };
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    await articles.update(env.DB, article.id, { png_r2_key: imageVersionKey(article.id, job.id)! });
    await imageJobs.finish(env.DB, article.id, job.id, "ready");
    await imageJobs.request(env.DB, article.id, "new", null);
    const next = await (await SELF.fetch(`https://x.test/articles/${article.id}/image-status`)).json() as { version: string; revision: string; state: string };
    expect(first.version).toBe("original");
    expect(next.version).toBe(job.id);
    expect(next.revision).not.toBe(first.revision);
    expect(next.state).toBe("queued");
  });

  it("hides an unfinished PNG until validation completes and retains a rendered copy after an attachment failure", async () => {
    const { article } = await fixture();
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    await env.ASSETS.put(imageVersionKey(article.id, job.id)!, "rendered copy");
    expect(await listImageVersions(env.ASSETS, article, job)).toEqual([]);
    await imageJobs.finish(env.DB, article.id, job.id, "failed", "Article changed");
    expect(await listImageVersions(env.ASSETS, article, await imageJobs.get(env.DB, article.id))).toHaveLength(1);
  });

  it("follows R2 cursors so older copies are never dropped", async () => {
    const { article } = await fixture();
    const version = `img_${"c".repeat(32)}`;
    const list = vi.spyOn(env.ASSETS, "list");
    list.mockResolvedValueOnce({ objects: [{ key: imageVersionKey(article.id, "original")!, uploaded: new Date(1000) }], truncated: true, cursor: "next", delimitedPrefixes: [] } as any);
    list.mockResolvedValueOnce({ objects: [{ key: imageVersionKey(article.id, version)!, uploaded: new Date(2000) }], truncated: false, delimitedPrefixes: [] } as any);
    try {
      expect((await listImageVersions(env.ASSETS, article)).map((v) => v.id)).toEqual(["original", version]);
      expect(list.mock.calls[1]?.[0]?.cursor).toBe("next");
    } finally { list.mockRestore(); }
  });

  it("isolates all gallery, image and brief requests by owner and rejects arbitrary asset paths", async () => {
    const { article } = await fixture(`other-${crypto.randomUUID()}@example.com`);
    for (const suffix of ["images", "images/original/featured.png", "images/original/image-brief"]) {
      expect((await SELF.fetch(`https://x.test/articles/${article.id}/${suffix}`)).status).toBe(404);
      const unauthenticated = await worker.fetch(new Request(`https://x.test/articles/${article.id}/${suffix}`, { headers: { accept: "application/json" } }), { ...env, DEV_AUTH_EMAIL: undefined });
      expect(unauthenticated.status).toBe(401);
    }
    const own = await fixture();
    for (const version of ["../other", "img_invalid", "original/../../secret", "img_" + "f".repeat(33)]) expect(imageVersionKey(own.article.id, version)).toBeNull();
    expect((await SELF.fetch(`https://x.test/articles/${own.article.id}/images/img_invalid/featured.png`)).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/articles/${own.article.id}/images/original/bundle.zip`)).status).toBe(404);
  });
});
