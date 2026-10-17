import { describe, expect, it } from "vitest";
import {
  stripDashes,
  hasDash,
  applyStyle,
  styleWithRegenerate,
  stripSourceMarkers,
} from "../src/style/lint";
import { countWords, trimToWordCap, voiceInstruction } from "../src/style/engine";
import type { GeneratedArticle } from "../src/text/article";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';

function article(over: Partial<GeneratedArticle> = {}): GeneratedArticle {
  return {
    title: "A title",
    body_html: `<p>Body text here.</p>${SVG}`,
    excerpt: "An excerpt.",
    meta_desc: "A meta description.",
    slug: "a-title",
    key_phrases: ["one", "two"],
    ...over,
  };
}

describe("dash stripping (T7 hard rule)", () => {
  it("removes em-dashes entirely", () => {
    const out = stripDashes("Style matters — a lot — really.");
    expect(hasDash(out)).toBe(false);
    expect(out).not.toContain("—");
  });

  it("removes en-dashes used as punctuation", () => {
    const out = stripDashes("Design – then build – then ship.");
    expect(hasDash(out)).toBe(false);
  });

  it("converts numeric ranges to a hyphen", () => {
    expect(stripDashes("Years 2020–2024 grew.")).toBe("Years 2020-2024 grew.");
  });

  it("joins two sentences with a period", () => {
    const out = stripDashes("It works — This is why.");
    expect(out).toContain(". This");
    expect(hasDash(out)).toBe(false);
  });
});

describe("source marker stripping (grounding ids never leak)", () => {
  it("removes single and grouped [S#] markers and tidies spacing", () => {
    expect(stripSourceMarkers("Costs fell 40% [S2].")).toBe("Costs fell 40%.");
    expect(stripSourceMarkers("It scales [S1, S3] well.")).toBe("It scales well.");
    expect(stripSourceMarkers("Two facts [S1][S2] here.")).toBe("Two facts here.");
    expect(stripSourceMarkers("lowercase [s4] too")).toBe("lowercase too");
  });

  it("leaves ordinary bracketed text alone", () => {
    expect(stripSourceMarkers("See [the docs] and [Section 2].")).toBe(
      "See [the docs] and [Section 2].",
    );
  });

  it("applyStyle strips leaked markers from body, key phrases and slug", () => {
    const out = applyStyle(
      {
        title: "Cloud PBX [S1] guide",
        body_html: "<p>Uptime is 99.9% [S1] across regions [S2].</p>",
        excerpt: "e",
        meta_desc: "m",
        slug: "cloud-pbx-[S1]",
        key_phrases: ["cloud PBX [S1]", "voip [S2]"],
      },
      500,
    );
    expect(out.article.body_html).not.toContain("[S1]");
    expect(out.article.body_html).toContain("across regions.");
    expect(out.article.title).toBe("Cloud PBX guide");
    // No stranded "S1"/"s1" token in key phrases or the slug source.
    expect(out.article.key_phrases.join(" ")).not.toMatch(/\bs1\b/i);
    expect(out.article.slug.toLowerCase()).not.toContain("s1");
  });
});

describe("word cap (T7: trim, never pad)", () => {
  it("counts words excluding svg and tags", () => {
    expect(countWords(`<p>one two three</p>${SVG}`)).toBe(3);
  });

  it("trims over-length body but keeps the svg", () => {
    const body =
      Array.from({ length: 20 }, (_, i) => `<p>word${i} filler here now</p>`).join("") +
      SVG;
    const trimmed = trimToWordCap(body, 12);
    expect(countWords(trimmed)).toBeLessThanOrEqual(12);
    expect(/<svg[\s>]/i.test(trimmed)).toBe(true);
  });

  it("does not pad short bodies", () => {
    const body = `<p>short body</p>${SVG}`;
    expect(trimToWordCap(body, 100)).toBe(body);
  });
});

describe("applyStyle", () => {
  it("produces zero dashes and caps meta at 160", () => {
    const long = "x".repeat(200);
    const res = applyStyle(
      article({
        title: "Ship — fast",
        meta_desc: long,
        body_html: `<p>Body — text — here.</p>${SVG}`,
      }),
      650,
    );
    expect(res.dashesFound).toBe(false);
    expect(res.article.meta_desc.length).toBeLessThanOrEqual(160);
    expect(hasDash(res.article.body_html)).toBe(false);
  });
});

describe("styleWithRegenerate (T7: one regeneration on failure)", () => {
  it("regenerates exactly once when the first output blows the cap", async () => {
    let calls = 0;
    const bloated = article({
      body_html:
        Array.from({ length: 40 }, (_, i) => `<p>filler word ${i} again</p>`).join("") +
        SVG,
    });
    const regen = async () => {
      calls++;
      return article({ body_html: `<p>tight body copy</p>${SVG}` });
    };
    const out = await styleWithRegenerate(bloated, 10, regen);
    expect(calls).toBe(1);
    expect(countWords(out.body_html)).toBeLessThanOrEqual(10);
    expect(hasDash(out.body_html)).toBe(false);
  });

  it("does not regenerate when the first output is clean", async () => {
    let calls = 0;
    const out = await styleWithRegenerate(article(), 650, async () => {
      calls++;
      return article();
    });
    expect(calls).toBe(0);
    expect(out.title).toBe("A title");
  });
});

describe("voice profiles (data rows)", () => {
  it("defaults to ms-en", () => {
    expect(voiceInstruction("nope")).toBe(voiceInstruction("ms-en"));
    expect(voiceInstruction("ms-en")).toContain("Malaysian");
  });
});
