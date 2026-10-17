import { describe, expect, it } from "vitest";
import { sectionWordBudget, planSectionCount } from "../src/text/article";

describe("agentic article: section word budget", () => {
  it("divides the bulk of the words across sections, leaving room for intro", () => {
    // 85% of 2000 = 1700, over 5 sections = 340 each
    expect(sectionWordBudget(2000, 5)).toBe(340);
  });

  it("is resilient to a zero section count", () => {
    expect(sectionWordBudget(1000, 0)).toBeGreaterThan(0);
  });

  it("floor scales down for short caps so budgets never exceed the total (M-01)", () => {
    // A long article's per-section budget must fit under the cap.
    const count = planSectionCount(2000);
    expect(sectionWordBudget(2000, count) * count).toBeLessThanOrEqual(2000);
  });
});

describe("agentic article: plan section count (M-01)", () => {
  it("derives a fitting section count from the word cap", () => {
    expect(planSectionCount(2000)).toBeLessThanOrEqual(6);
    expect(planSectionCount(2000)).toBeGreaterThanOrEqual(2);
  });

  it("keeps section*budget within the cap across the supported range", () => {
    for (const cap of [500, 800, 1200, 1600, 2000]) {
      const n = planSectionCount(cap);
      expect(sectionWordBudget(cap, n) * n).toBeLessThanOrEqual(cap);
    }
  });

  it("never asks for more than 6 or fewer than 2 sections", () => {
    expect(planSectionCount(50)).toBe(2);
    expect(planSectionCount(100000)).toBe(6);
  });
});
