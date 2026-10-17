import { describe, expect, it } from "vitest";
import { toMarkdown, toPlain, toSocial, toWordDoc, renderOutput, isRichFormat } from "../src/content/render";

const RICH = `<h2>Cloud PBX</h2><p>It is <strong>cheaper</strong> and <a href="https://x.test/p">scales</a>.</p><ul><li>Per seat</li><li>No hardware</li></ul><table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Basic</td><td>RM10</td></tr></tbody></table><blockquote><p>Ready to switch?</p></blockquote>`;

describe("markdown rendering", () => {
  const md = toMarkdown(RICH);
  it("uses # headings, bold, and links", () => {
    expect(md).toContain("## Cloud PBX");
    expect(md).toContain("**cheaper**");
    expect(md).toContain("[scales](https://x.test/p)");
  });
  it("renders bullet lists and a markdown table", () => {
    expect(md).toContain("- Per seat");
    expect(md).toContain("| Plan | Price |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Basic | RM10 |");
  });
  it("renders blockquotes with >", () => {
    expect(md).toContain("> Ready to switch?");
  });
  it("emits no HTML tags and no em/en dashes", () => {
    expect(md).not.toMatch(/<[a-z]/i);
    expect(md).not.toMatch(/[–—]/);
  });
});

describe("plain-text rendering", () => {
  const txt = toPlain(RICH);
  it("strips all markup", () => {
    expect(txt).not.toMatch(/<[a-z]/i);
    expect(txt).not.toContain("**");
    expect(txt).not.toContain("## ");
  });
  it("keeps heading and list text and inlines link URLs", () => {
    expect(txt).toContain("Cloud PBX");
    expect(txt).toContain("- Per seat");
    expect(txt).toContain("scales (https://x.test/p)");
  });
  it("flattens a table into readable rows (no HTML)", () => {
    expect(txt).toContain("Plan  |  Price");
    expect(txt).toContain("Basic  |  RM10");
  });
});

describe("social rendering", () => {
  it("is plain text and appends hashtags from key phrases when missing", () => {
    const s = toSocial("<p>Great news about our launch.</p>", ["cloud pbx", "malaysia sme"]);
    expect(s).not.toMatch(/<[a-z]/i);
    expect(s).toContain("#CloudPbx");
    expect(s).toContain("#MalaysiaSme");
  });
  it("does not add hashtags when the post already has them", () => {
    const s = toSocial("<p>Launch day! #Launch</p>", ["cloud pbx"]);
    expect(s).not.toContain("#CloudPbx");
    expect(s).toContain("#Launch");
  });
});

describe("word document", () => {
  it("wraps the html in an office-namespaced document", () => {
    const doc = toWordDoc("<h2>T</h2><p>body</p>", "My Title");
    expect(doc).toContain("urn:schemas-microsoft-com:office:word");
    expect(doc).toContain("<title>My Title</title>");
    expect(doc).toContain("<h2>T</h2>");
  });
});

describe("renderOutput dispatch", () => {
  it("returns correct ext/mime per format", () => {
    expect(renderOutput("<p>x</p>", "markdown", { keyPhrases: [], title: "t" }).ext).toBe("md");
    expect(renderOutput("<p>x</p>", "plain", { keyPhrases: [], title: "t" }).ext).toBe("txt");
    expect(renderOutput("<p>x</p>", "social", { keyPhrases: [], title: "t" }).ext).toBe("txt");
    expect(renderOutput("<p>x</p>", "word", { keyPhrases: [], title: "t" }).ext).toBe("doc");
    const html = renderOutput("<p>x</p>", "html", { keyPhrases: [], title: "t" });
    expect(html.ext).toBe("html");
    expect(html.body).toBe("<p>x</p>");
  });
  it("marks html and word as rich, others as text", () => {
    expect(isRichFormat("html")).toBe(true);
    expect(isRichFormat("word")).toBe(true);
    expect(isRichFormat("markdown")).toBe(false);
    expect(isRichFormat("plain")).toBe(false);
    expect(isRichFormat("social")).toBe(false);
  });
});

describe("markdown escaping (M-04)", () => {
  it("escapes inline emphasis/code/bracket metacharacters in text", () => {
    const md = toMarkdown("<p>Use _val_ and *x* and `code` and [n] here.</p>");
    expect(md).toContain("\\_val\\_");
    expect(md).toContain("\\*x\\*");
    expect(md).toContain("\\`code\\`");
    expect(md).toContain("\\[n\\]");
  });
  it("does not escape ordinary periods or hyphens", () => {
    const md = toMarkdown("<p>Version 1.2 is well-tested.</p>");
    expect(md).toContain("Version 1.2 is well-tested.");
  });
  it("escapes a leading block marker so a paragraph stays a paragraph", () => {
    expect(toMarkdown("<p># not a heading</p>")).toContain("\\# not a heading");
    expect(toMarkdown("<p>- not a list</p>")).toContain("\\- not a list");
    expect(toMarkdown("<p>1. not ordered</p>")).toContain("1\\. not ordered");
  });
  it("angle-wraps link destinations containing spaces or parens", () => {
    const md = toMarkdown('<p><a href="https://x.test/a(b) c">link</a></p>');
    expect(md).toContain("[link](<https://x.test/a(b) c>)");
  });
  it("escapes brackets inside a link label", () => {
    const md = toMarkdown('<p><a href="https://x.test">a [b] c</a></p>');
    expect(md).toContain("[a \\[b\\] c](https://x.test)");
  });
});

describe("social hard cap (M-03)", () => {
  it("caps the whole post, hashtags included, at maxWords", () => {
    const long = "<p>" + Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + "</p>";
    const s = toSocial(long, ["cloud pbx", "sme"], 50);
    const words = s.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(50);
    // hashtags survive the trim (body is trimmed to make room)
    expect(s).toContain("#CloudPbx");
  });
  it("respects a caller cap below the default", () => {
    const s = toSocial("<p>" + "x ".repeat(100) + "</p>", [], 10);
    expect(s.trim().split(/\s+/).length).toBeLessThanOrEqual(10);
  });
});

describe("entity decoding", () => {
  it("decodes entities in text and hrefs", () => {
    const md = toMarkdown('<p>A &amp; B &#39;quote&#39;</p>');
    expect(md).toContain("A & B 'quote'");
  });
});
