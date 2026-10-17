import { describe, expect, it } from "vitest";
import {
  articleSignature,
  jaccard,
  similarity,
  mostSimilar,
  SIMILAR_THRESHOLD,
} from "../src/content/similarity";

describe("jaccard", () => {
  it("is 1 for identical sets, 0 for disjoint", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("article similarity", () => {
  const A = articleSignature(
    "Cloud PBX Guide for Malaysian SMEs",
    "<p>Cloud PBX lowers hardware cost and scales per seat for growing teams in Malaysia.</p>",
  );
  const nearDup = articleSignature(
    "Cloud PBX Guide for Malaysian SMEs",
    "<p>Cloud PBX lowers hardware cost and scales per seat for growing teams in Malaysia.</p>",
  );
  const related = articleSignature(
    "Cloud PBX pricing for small business",
    "<p>Cloud PBX plans in Malaysia are billed per seat and scale with team size.</p>",
  );
  const unrelated = articleSignature(
    "How to bake sourdough bread at home",
    "<p>Mix flour and water, ferment the starter, then bake in a hot dutch oven.</p>",
  );

  it("scores a near-duplicate at/above the flag threshold", () => {
    expect(similarity(A, nearDup)).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
  });

  it("scores an unrelated article well below the threshold", () => {
    expect(similarity(A, unrelated)).toBeLessThan(SIMILAR_THRESHOLD);
  });

  it("ranks the near-duplicate as most similar", () => {
    const best = mostSimilar(A, [
      { title: "unrelated", signature: unrelated },
      { title: "related", signature: related },
      { title: "the dup", signature: nearDup },
    ]);
    expect(best?.title).toBe("the dup");
  });

  it("returns null when there are no priors", () => {
    expect(mostSimilar(A, [])).toBeNull();
  });
});
