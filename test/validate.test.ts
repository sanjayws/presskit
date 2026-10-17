import { describe, expect, it } from "vitest";
import {
  canonicalizeSlug,
  normalizeArticle,
  sanitizeKeyPhrase,
  sanitizeKeyPhrases,
  validatedImageMime,
} from "../src/content/validate";
import { validateGroundingUrl } from "../src/grounding/ingest";

describe("content validation (H-05)", () => {
  it("canonicalizes slugs and falls back to the title", () => {
    expect(canonicalizeSlug("Hello World!", "t")).toBe("hello-world");
    expect(canonicalizeSlug("  Café Crème  ", "t")).toBe("cafe-creme");
    expect(canonicalizeSlug("", "My Great Title")).toBe("my-great-title");
    expect(canonicalizeSlug("", "")).toBe("article");
  });

  it("normalizes an article to the persisted contract", () => {
    const n = normalizeArticle({
      title: "  T  ",
      body_html: "<p>Body text here for excerpt fallback.</p>",
      excerpt: "",
      meta_desc: "x".repeat(300),
      slug: "Weird Slug",
      key_phrases: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    });
    expect(n.title).toBe("T");
    expect(n.slug).toBe("weird-slug");
    expect(n.meta_desc.length).toBeLessThanOrEqual(160);
    expect(n.excerpt).toContain("Body text");
    expect(n.key_phrases.length).toBeLessThanOrEqual(8);
  });

  it("strips commas and special characters from a focus keyphrase", () => {
    expect(sanitizeKeyPhrase("cloud PBX, Malaysia")).toBe("cloud PBX Malaysia");
    expect(sanitizeKeyPhrase("VoIP & SIP (2026)!")).toBe("VoIP SIP 2026");
    expect(sanitizeKeyPhrase("  Café / Crème  ")).toBe("Café Crème");
    expect(sanitizeKeyPhrase("first-class, service")).toBe("first-class service");
    expect(sanitizeKeyPhrase("!!!,,,###")).toBe("");
  });

  it("cleans, de-dupes and caps a key-phrase list", () => {
    const out = sanitizeKeyPhrases(["cloud pbx", "Cloud PBX", "voip!", "", "a, b"]);
    expect(out).toEqual(["cloud pbx", "voip", "a b"]);
    expect(sanitizeKeyPhrases(Array.from({ length: 20 }, (_, i) => `kw${i}`))).toHaveLength(8);
  });

  it("accepts real PNG/JPEG signatures and rejects junk/oversize", () => {
    expect(validatedImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]))).toBe("image/png");
    expect(validatedImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
    expect(validatedImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(validatedImageMime(new Uint8Array(0))).toBeNull();
  });
});

describe("grounding URL policy (H-02 SSRF)", () => {
  it("accepts normal https URLs", () => {
    expect(() => validateGroundingUrl("https://example.com/page")).not.toThrow();
    expect(() => validateGroundingUrl("http://blog.example.com")).not.toThrow();
  });

  it("rejects non-http, credentials, private hosts, and odd ports", () => {
    expect(() => validateGroundingUrl("ftp://example.com")).toThrow();
    expect(() => validateGroundingUrl("https://user:pw@example.com")).toThrow();
    expect(() => validateGroundingUrl("http://localhost/x")).toThrow();
    expect(() => validateGroundingUrl("http://127.0.0.1/x")).toThrow();
    expect(() => validateGroundingUrl("http://10.0.0.5/x")).toThrow();
    expect(() => validateGroundingUrl("http://192.168.1.1/x")).toThrow();
    expect(() => validateGroundingUrl("http://169.254.169.254/latest")).toThrow();
    expect(() => validateGroundingUrl("http://example.com:8080/x")).toThrow();
    expect(() => validateGroundingUrl("http://intranet/x")).toThrow(); // no dot
  });
});
