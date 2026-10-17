import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  htmlToText,
  sha256Hex,
  ingestUpload,
  loadGroundingText,
} from "../src/grounding/ingest";
import { campaigns, users } from "../src/db/repos";

describe("htmlToText (T3 clean text)", () => {
  it("keeps content after a nested article and keeps multiple article regions", () => {
    const intro = "Network assessment guidance for a safe migration. ".repeat(3);
    const html = `<main><p>${intro}</p><article><p>First topic.</p></article><section>Required final network checks.</section></main>`;
    expect(htmlToText(html)).toContain("Required final network checks.");
    expect(htmlToText(`<article>${intro}</article><article>Second topic and the required ending.</article>`)).toContain("Second topic and the required ending.");
  });
  it("strips scripts, styles, and tags to readable text", () => {
    const html = `<html><head><style>.x{color:red}</style><script>alert(1)</script></head>
<body><h1>Title</h1><p>Hello&nbsp;<b>world</b>.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<");
  });

  it("decodes numeric entities", () => {
    expect(htmlToText("<p>caf&#233; &amp; tea</p>")).toContain("café & tea");
  });

  it("does not crash on out-of-range numeric entities", () => {
    // > 0x10FFFF would make String.fromCodePoint throw; must be handled safely.
    expect(() => htmlToText("<p>bad &#999999999; and &#x1FFFFFF; ok</p>")).not.toThrow();
    expect(htmlToText("<p>hi &#999999999; there</p>")).toContain("hi");
  });
});

describe("sha256Hex (T3 stable hash)", () => {
  it("is stable and 64 hex chars", async () => {
    const a = await sha256Hex("hello world");
    const b = await sha256Hex("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ingest + load (T3 store to R2, ground-or-refuse)", () => {
  it("stores an uploaded doc and loads it back from R2", async () => {
    const u = await users.upsertByEmail(env.DB, "ing@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "test",
      grounding_refs: [],
    });
    const body = "This is a grounding document with plenty of readable content in it.";
    const { doc, text } = await ingestUpload(env, c.id, "notes.txt", body);
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(text).toContain("grounding document");

    const stored = await env.ASSETS.get(doc.r2_key);
    expect(stored).not.toBeNull();

    const loaded = await loadGroundingText(env, c.id);
    expect(loaded).toContain("grounding document");
  });

  it("dedupes concurrent identical ingests to one row (M-04)", async () => {
    const u = await users.upsertByEmail(env.DB, "race@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "test",
      grounding_refs: [],
    });
    const body = "Identical grounding content ingested twice at the same time here.";
    // Two concurrent ingests of the same content: the unique index + ON CONFLICT
    // must collapse them to a single canonical row, not two duplicates.
    const [a, b] = await Promise.all([
      ingestUpload(env, c.id, "dup.txt", body),
      ingestUpload(env, c.id, "dup.txt", body),
    ]);
    expect(a.doc.hash).toBe(b.doc.hash);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM grounding_docs WHERE campaign_id = ?",
    )
      .bind(c.id)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("refuses when a campaign has no grounding", async () => {
    const u = await users.upsertByEmail(env.DB, "empty@example.com");
    const c = await campaigns.create(env.DB, {
      user_id: u.id,
      idea: "test",
      grounding_refs: [],
    });
    await expect(loadGroundingText(env, c.id)).rejects.toThrow(/ground or refuse/);
  });
});
