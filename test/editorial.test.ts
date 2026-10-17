import { describe, expect, it } from "vitest";
import { biasInstruction, editorialBlock } from "../src/text/article";

const base = {
  topicTitle: "t",
  angle: "a",
  primaryKw: "kw",
  voiceProfileInstruction: "US English.",
  maxWords: 800,
  groundingText: "[S1] url: x\nfacts",
};

describe("bias dial", () => {
  it("level 1 is neutral/honest, not promotional", () => {
    const s = biasInstruction(1).toLowerCase();
    expect(s).toContain("neutral");
    expect(s).toContain("honest");
  });

  it("level 5 is strongly promotional but still forbids fabrication", () => {
    const s = biasInstruction(5).toLowerCase();
    expect(s).toContain("promotional");
    // Ground-or-refuse must hold even at the most promotional setting.
    expect(s).toContain("not fabricate");
    expect(s).toContain("never conceal material limitations");
    expect(s).toContain("comparison verdicts");
  });

  it("defaults to the balanced stance for out-of-range/unset levels", () => {
    expect(biasInstruction(3)).toBe(biasInstruction(99));
    expect(biasInstruction(3).toLowerCase()).toContain("balanced");
  });
});

describe("editorial block", () => {
  it("carries include and exclude directives verbatim", () => {
    const out = editorialBlock({
      ...base,
      includeIdeas: "per-seat pricing, uptime SLA",
      excludeIdeas: "competitor names",
      biasLevel: 4,
    });
    expect(out).toContain("Must cover");
    expect(out).toContain("per-seat pricing, uptime SLA");
    expect(out).toContain("Must avoid");
    expect(out).toContain("competitor names");
    expect(out).toContain("never conceal or contradict a material limitation");
    expect(out.toLowerCase()).toContain("persuasive");
  });

  it("omits include/exclude lines when blank, but always states a stance", () => {
    const out = editorialBlock({ ...base, includeIdeas: "  ", excludeIdeas: "" });
    expect(out).not.toContain("Must cover");
    expect(out).not.toContain("Must avoid");
    expect(out.toLowerCase()).toContain("balanced"); // default bias 3
  });
});
