import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { buildBundle, articleHtmlDocument } from "../src/bundle/export";
import { users, campaigns, runs, articles } from "../src/db/repos";

describe("download-all bundle (T10)", () => {
  it("wraps body in a standalone html document", () => {
    const doc = articleHtmlDocument({
      id: "a",
      run_id: "r",
      title: "Hello",
      body_html: "<p>hi</p>",
      excerpt: "e",
      slug: "hello",
      meta_desc: "m",
      key_phrases: "[]",
      svg_r2_key: null,
      png_r2_key: null,
      bundle_r2_key: null,
      similar_to: "",
      similar_score: 0,
      output_format: "html",
      output_body: "",
    });
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<title>Hello</title>");
    expect(doc).toContain("<p>hi</p>");
  });

  it("produces a zip with html + meta.json (and assets when present)", async () => {
    const u = await users.upsertByEmail(env.DB, "zip@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "x",
      grounding_refs: [],
    });
    const r = await runs.create(env.DB, c.id);

    await env.ASSETS.put("svg/z", "<svg></svg>");
    await env.ASSETS.put("png/z", new Uint8Array([1, 2, 3]));

    const a = await articles.create(env.DB, {
      run_id: r.id,
      title: "Zip Me",
      body_html: "<p>body</p><svg></svg>",
      excerpt: "exc",
      slug: "zip-me",
      meta_desc: "meta here",
      key_phrases: JSON.stringify(["kp1", "kp2"]),
      png_r2_key: "png/z",
    });
    await env.ASSETS.put(`articles/${a.id}/image-brief.json`, JSON.stringify({ version: "2026-10-01.1", prompt: "Approved article infographic" }));

    const zip = await buildBundle(env, a);
    const entries = unzipSync(zip);
    const names = Object.keys(entries).sort();
    expect(names).toEqual(["article.html", "featured.png", "image-brief.json", "meta.json"]);
    expect(JSON.parse(strFromU8(entries["image-brief.json"]!)).prompt).toBe("Approved article infographic");

    const meta = JSON.parse(strFromU8(entries["meta.json"]!));
    expect(meta.title).toBe("Zip Me");
    expect(meta.slug).toBe("zip-me");
    expect(meta.key_phrases).toEqual(["kp1", "kp2"]);
    expect(strFromU8(entries["article.html"]!)).toContain("<p>body</p>");
  });
});
