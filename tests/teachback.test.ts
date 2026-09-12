import { describe, expect, it } from "vitest";
import { TEACHBACK_KEYWORDS, scoreTeachback } from "@/lib/tutor";

const KEYWORDS = TEACHBACK_KEYWORDS.c_position;

// Kitchen-sink answer built from the real keyword list, so coverage must be
// ~1 however the list is cut. Every keyword also appears in natural prose.
const FULL = `In my own words: ${KEYWORDS.join(", ")}. Self-attention compares tokens, ` +
  "but without positional information the model loses order because attention " +
  "is permutation-equivariant over the sequence.";

describe("scoreTeachback (pure teachback rubric)", () => {
  it("full-keyword answer → coverage ≈ 1, verdict strong", async () => {
    const r = await scoreTeachback(FULL, KEYWORDS);
    expect(r.coverage).toBeGreaterThanOrEqual(0.99);
    expect(r.coverage).toBeLessThanOrEqual(1);
    expect(r.verdict).toBe("strong");
    expect(r.misses).toHaveLength(0);
  });

  it("weak answer → needs-work with low coverage", async () => {
    const r = await scoreTeachback("I am not sure. Maybe something about stuff?", KEYWORDS);
    expect(r.verdict).toBe("needs-work");
    expect(r.coverage).toBeLessThan(0.5);
    expect(r.misses.length).toBeGreaterThan(0);
  });

  it("negation is preserved: negated keywords do not count", async () => {
    const negated =
      "It does not involve order. It is not about permutation. " +
      "It never mentions positional. No sequence at all.";
    for (const k of KEYWORDS) expect(negated.toLowerCase()).toContain(k.toLowerCase());
    const r = await scoreTeachback(negated, KEYWORDS);
    expect(r.coverage).toBeLessThan(0.5);
    expect(r.verdict).toBe("needs-work");
  });

  it("misses are never silently truncated (route caps display at 4)", async () => {
    const six = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const r = await scoreTeachback("Hello world, I like pizza and the weather.", six);
    // All six missed: the scorer reports fully; the ROUTE slices display to 4.
    expect(r.misses).toHaveLength(6);
    expect(r.misses.slice(0, 4)).toHaveLength(4);
  });
});
