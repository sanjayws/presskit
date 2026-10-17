import { creativeDirection } from "./image-fixture";
import { describe, expect, it } from "vitest";
import {
  PERSONAS,
  TONES,
  IMAGE_STYLES,
  TEMPERATURE_PRESETS,
  optionInstruction,
  clampTemperature,
} from "../src/style/engine";
import { appendSignature, articleImageSummary } from "../src/pipeline/run";
import { featuredImagePrompt } from "../src/images/brief";

describe("generation gears (options -> instructions)", () => {
  it("resolves persona/tone/image instructions by value", () => {
    expect(optionInstruction(PERSONAS, "ceo").toLowerCase()).toContain("ceo");
    expect(optionInstruction(TONES, "witty").toLowerCase()).toContain("witty");
    expect(optionInstruction(IMAGE_STYLES, "dark").toLowerCase()).toContain("dark");
    expect(optionInstruction(PERSONAS, "")).toBe("");
    expect(optionInstruction(PERSONAS, "nonexistent")).toBe("");
  });

  it("offers a range of creativity presets", () => {
    const vals = TEMPERATURE_PRESETS.map((t) => Number(t.value));
    expect(Math.min(...vals)).toBeLessThan(0.5);
    expect(Math.max(...vals)).toBeGreaterThan(1);
  });

  it("clamps temperature into range", () => {
    expect(clampTemperature(0.9)).toBe(0.9);
    expect(clampTemperature(5)).toBe(2);
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature(NaN)).toBe(0.6);
  });
});

describe("signature append (house-style cleaned)", () => {
  it("appends a signature paragraph and strips dashes", () => {
    const out = appendSignature("<p>Body.</p>", "— Alex, CEO");
    expect(out).toContain("article-signature");
    expect(out).toContain("Alex, CEO");
    expect(out).not.toContain("—");
  });

  it("no-ops when signature is empty", () => {
    expect(appendSignature("<p>Body.</p>", "")).toBe("<p>Body.</p>");
  });
});

describe("image style direction flows into the prompt", () => {
  it("includes the style direction text", () => {
    const p = featuredImagePrompt({ ...creativeDirection, headline: "Cloud costs", layout: "concept", points: [] }, {
      title: "Cloud costs",
      sourceText: "Cloud costs depend on usage.",
      styleDirection: "Dark mode: deep background, luminous accents",
    });
    expect(p).toContain("Dark mode");
  });
});

describe("article image summary", () => {
  it("pulls excerpt, headings and key phrases", () => {
    const summary = articleImageSummary({
      id: "a",
      run_id: "r",
      title: "t",
      body_html: "<h2>Costs</h2><p>x</p><h2>Security</h2>",
      excerpt: "An excerpt.",
      slug: "t",
      meta_desc: "m",
      key_phrases: JSON.stringify(["cloud pbx", "sme"]),
      svg_r2_key: null,
      png_r2_key: null,
      bundle_r2_key: null,
      similar_to: "",
      similar_score: 0,
      output_format: "html",
      output_body: "",
    });
    expect(summary).toContain("An excerpt.");
    expect(summary).toContain("Costs");
    expect(summary).toContain("Security");
    expect(summary).toContain("cloud pbx");
  });
});
