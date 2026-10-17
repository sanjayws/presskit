import { describe, expect, it } from "vitest";
import {
  parseReferenceLinksText,
  readReferenceLinks,
  enrichArticleBody,
  enrichmentReserveWords,
} from "../src/content/enrich";
import { ctaByValue, buildCtaHref } from "../src/style/engine";

const demoCta = (href: string | null) => ({ preset: ctaByValue("demo")!, href });

describe("reference link parsing", () => {
  it("parses URL and 'URL | label' lines, dropping non-http", () => {
    const links = parseReferenceLinksText(
      "https://a.com/x | our pricing\nhttps://b.com\nnot a url\nftp://c.com/y",
    );
    expect(links).toEqual([
      { url: "https://a.com/x", label: "our pricing" },
      { url: "https://b.com", label: "" },
    ]);
  });

  it("round-trips through the stored JSON form", () => {
    const json = JSON.stringify(parseReferenceLinksText("https://a.com | Alpha"));
    expect(readReferenceLinks(json)).toEqual([{ url: "https://a.com", label: "Alpha" }]);
    expect(readReferenceLinks("garbage")).toEqual([]);
    expect(readReferenceLinks("[{}]")).toEqual([]);
  });

  it("bounds URL and label length and caps at ten links", () => {
    const longUrl = "https://a.com/" + "x".repeat(5000);
    const [link] = parseReferenceLinksText(`${longUrl} | ${"L".repeat(500)}`);
    expect(link!.url.length).toBeLessThanOrEqual(2048);
    expect(link!.label.length).toBeLessThanOrEqual(160);

    const many = Array.from({ length: 25 }, (_, i) => `https://a.com/${i}`).join("\n");
    expect(parseReferenceLinksText(many)).toHaveLength(10);
  });
});

describe("article body enrichment", () => {
  const body =
    "<p>We offer flexible pricing for teams.</p><h2>Details</h2><p>More text.</p><h2>Conclusion</h2><p>End.</p>";

  it("does not inject unverified free, no-card or no-obligation terms", () => {
    for (const value of ["trial", "consult", "quote", "demo"]) {
      const preset = ctaByValue(value)!;
      expect(`${preset.label} ${preset.body} ${preset.action}`).not.toMatch(/free|no credit card|no-obligation|first-hand/i);
    }
  });

  it("links the first mention of a label inline", () => {
    const out = enrichArticleBody(body, [{ url: "https://x.com/p", label: "pricing" }], null);
    expect(out).toContain('<a href="https://x.com/p">pricing</a>');
    // Only the first occurrence is linked (one anchor).
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("adds unmatched links to a Further reading list", () => {
    const out = enrichArticleBody(body, [{ url: "https://x.com/z", label: "nowhere-here" }], null);
    expect(out).toContain("Further reading");
    expect(out).toContain('<a href="https://x.com/z">nowhere-here</a>');
  });

  it("does not link inside a heading", () => {
    const out = enrichArticleBody(body, [{ url: "https://x.com/d", label: "Details" }], null);
    // "Details" only appears in the <h2>, so the heading stays untouched and the
    // link falls through to Further reading instead of being anchored inline.
    expect(out).toContain("<h2>Details</h2>");
    expect(out).toContain("Further reading");
  });

  it("inserts the CTA blockquote before the last section", () => {
    const out = enrichArticleBody(body, [], demoCta(null));
    expect(out).toContain("<blockquote>");
    // Blockquote sits before the final <h2> (the Conclusion).
    expect(out.indexOf("<blockquote>")).toBeLessThan(out.lastIndexOf("<h2"));
  });

  it("links the CTA button to its own configured action, not a ref link", () => {
    const out = enrichArticleBody(
      body,
      [{ url: "https://x.com/further", label: "" }],
      demoCta("tel:+60312345678"),
    );
    expect(out).toContain('<a href="tel:+60312345678">Book a demo</a>');
    // The ref link is NOT reused as the CTA target; it goes to Further reading.
    expect(out).not.toContain('<a href="https://x.com/further">Book a demo</a>');
    expect(out).toContain("Further reading");
  });

  it("renders a text-only CTA when there is no href", () => {
    const out = enrichArticleBody(body, [], demoCta(null));
    expect(out).toContain("<blockquote>");
    expect(out).not.toContain("<a ");
  });

  it("is a no-op when there is nothing to add", () => {
    expect(enrichArticleBody(body, [], null)).toBe(body);
  });

  it("does not auto-link inside code/pre; falls through to Further reading", () => {
    const withCode = "<p>Use the <code>pricing</code> API endpoint.</p><h2>End</h2><p>x</p>";
    const out = enrichArticleBody(withCode, [{ url: "https://x.com/p", label: "pricing" }], null);
    expect(out).toContain("<code>pricing</code>"); // untouched
    expect(out).toContain("Further reading");
  });

  it("reserve word count grows with CTA and links, zero when empty", () => {
    expect(enrichmentReserveWords([], null)).toBe(0);
    const withCta = enrichmentReserveWords([], demoCta(null));
    expect(withCta).toBeGreaterThan(0);
    const withBoth = enrichmentReserveWords(
      [{ url: "https://x.com", label: "alpha beta" }],
      demoCta(null),
    );
    expect(withBoth).toBeGreaterThan(withCta);
  });
});

describe("CTA action href builder", () => {
  it("builds a website href, adding https when missing", () => {
    expect(buildCtaHref("website", "https://a.com/x")).toBe("https://a.com/x");
    expect(buildCtaHref("website", "a.com/x")).toBe("https://a.com/x");
  });

  it("builds mailto for a valid email only", () => {
    expect(buildCtaHref("email", "sales@a.com")).toBe("mailto:sales@a.com");
    expect(buildCtaHref("email", "not-an-email")).toBeNull();
  });

  it("builds a wa.me link from digits only", () => {
    expect(buildCtaHref("whatsapp", "+60 12-345 6789")).toBe("https://wa.me/60123456789");
    expect(buildCtaHref("whatsapp", "123")).toBeNull();
  });

  it("builds a tel: link keeping a leading +", () => {
    expect(buildCtaHref("call", "+60312345678")).toBe("tel:+60312345678");
    expect(buildCtaHref("call", "03-1234 5678")).toBe("tel:0312345678");
  });

  it("returns null for no action or blank target", () => {
    expect(buildCtaHref("", "x")).toBeNull();
    expect(buildCtaHref("website", "")).toBeNull();
  });
});
