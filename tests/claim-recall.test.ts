import { describe, expect, it } from "vitest";
import { COURSES, type Course } from "@/lib/courses";
import { CORPUS } from "@/lib/corpus";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim, sentencesOf } from "@/lib/tutor/claim";
import type { SourceChunk } from "@/lib/types";
import {
  CONTRAST_CONTROLS,
  CONTRAST_WRONG,
  PARROT,
  RIGHT,
  TRANSFORMERS,
  WRONG,
  runClaim,
} from "./fixtures/claim-corpus";

/**
 * How much of what a student gets wrong VIVA actually catches, and — the half
 * that matters more — how often it corrects somebody who was right.
 *
 * The corpus is fixed before the fix, not grown out of it: ten wrong sentences
 * an outside reviewer wrote against production on 13 Sep 2026, ten correct
 * sentences about the same subject, and the ten contrast sentences that guard
 * a fix already verified live. `tests/claim-check.test.ts` keeps the paired
 * mistake/refutation cases; this file keeps the score.
 *
 * Measured, both directions, same corpus:
 *
 *   wrong caught          2/10 → 7/10
 *   wrong-with-contrast   0/2  → 2/2
 *   right contradicted    0/20 → 0/20
 *   every true sentence VIVA ships (3910 of them)   27 → 26 contradicted
 *
 * The three still missed are named below with the reason, because a checker
 * that reports its own recall as complete is the failure this file replaced.
 */

const CAUGHT = new Set([
  "w01-qk-same",
  "w02-pos-after-softmax",
  "w03-mh-same-twice",
  "w04-heads-redundant",
  "w05-pos-multiplied",
  "w07-query-value-same",
  "w09-recurrence",
]);

/**
 * Still missed, and why. None of the three is a gate that can be widened
 * without asserting something the passages do not say:
 *
 *   w06  "self-attention ONLY lets a token look at the tokens before it" —
 *        a scope error. Catching it means reading "only" against p.4's
 *        "every other token", and the same rule fires on true sentences that
 *        narrow a claim honestly.
 *   w08  "positional encoding is only needed for very long sequences" — the
 *        source never says when it is needed, so there is no line to quote.
 *        This one is a correct refusal.
 *   w10  "self-attention is not permutation invariant…" — a real denial, and
 *        denials stay conservative on purpose. The passage says
 *        "permutation-equivariant", which shares no word with "permutation
 *        invariant"; nothing lexical connects them.
 */
const STILL_MISSED = new Set(["w06-causal-only", "w08-pos-long-only", "w10-not-permutation"]);

describe("recall on ten sentences that are plainly wrong", () => {
  for (const w of WRONG) {
    if (STILL_MISSED.has(w.id)) continue;
    it(`catches ${w.id}`, () => {
      const check = runClaim(TRANSFORMERS, w.text);
      expect(check.status).toBe("contradicted");
      // A correction with nothing to show for it is a lecture, not a check.
      expect(check.quote).toBeTruthy();
      expect(check.chunkId).toBeTruthy();
    });
  }

  it("catches at least seven of the ten", () => {
    const hits = WRONG.filter((w) => runClaim(TRANSFORMERS, w.text).status === "contradicted");
    expect(hits.map((h) => h.id).sort()).toEqual([...CAUGHT].sort());
  });

  it("says so honestly on the three it cannot place", () => {
    for (const id of STILL_MISSED) {
      const w = WRONG.find((x) => x.id === id)!;
      const check = runClaim(TRANSFORMERS, w.text);
      expect(check.status).not.toBe("contradicted");
      // A miss must never come back as agreement.
      expect(check.status).not.toBe("supported");
    }
  });
});

describe("wrong, and phrased with a contrast word", () => {
  // What splitting denial from contrast buys. Under the old single gate these
  // skipped every check on the strength of "instead of" / "rather than".
  for (const c of CONTRAST_WRONG) {
    it(`catches ${c.id}`, () => {
      expect(runClaim(TRANSFORMERS, c.text).status).toBe("contradicted");
    });
  }
});

describe("precision: nobody who was right gets told they were wrong", () => {
  for (const r of RIGHT) {
    it(`leaves alone ${r.id}`, () => {
      expect(runClaim(TRANSFORMERS, r.text).status).not.toBe("contradicted");
    });
  }

  // "Backpropagation and gradient descent are two different steps" was marked
  // wrong 5/5 before the contrast words went into the gate. That fix is
  // verified on production and every variant of it is nailed down here.
  for (const b of CONTRAST_CONTROLS) {
    it(`leaves alone the contrast control ${b.id}`, () => {
      expect(runClaim(TRANSFORMERS, b.text).status).not.toBe("contradicted");
    });
  }

  it("reading a line off the page is never a contradiction", () => {
    for (const p of PARROT) {
      expect(runClaim(TRANSFORMERS, p.text).status).not.toBe("contradicted");
    }
  });
});

/**
 * The whole library, both directions. Every sentence VIVA itself asserts —
 * every passage sentence, every authored correction, every formal explainer,
 * every concept description — none of which a student should be corrected for
 * saying back. 26 of 3910 come back contradicted, one fewer than before this
 * work and none of them new.
 *
 * The ceiling is a RATE, not a count, because the preloaded library is
 * generated (`scripts/seed-corpus.mjs`) and grew from eleven subjects to
 * twenty-four while this was being measured. A count would have gone red on
 * somebody else's re-seed and said nothing about the checker. The measured
 * rate is 0.665% (26 of 3910); the ratchet sits just above it, so widening
 * recall again cannot quietly buy itself precision. If it goes red right after
 * somebody re-runs the seed script, run it again — a half-written library.json
 * is not a checker regression.
 */
const FALSE_POSITIVE_RATE_CEILING = 0.008;

function everyChunk(c: Course): SourceChunk[] {
  return c.sources.flatMap((s) => s.chunks);
}

describe("precision across every subject VIVA ships", () => {
  it(`contradicts under ${(FALSE_POSITIVE_RATE_CEILING * 100).toFixed(1)}% of its own true sentences`, () => {
    const seen = new Set<string>();
    const flagged: string[] = [];
    let checked = 0;
    for (const course of [...Object.values(COURSES), ...CORPUS] as Course[]) {
      if (seen.has(course.id)) continue;
      seen.add(course.id);
      const chunks = everyChunk(course);
      const truths = [
        ...chunks.flatMap((c) => sentencesOf(c.text)),
        ...course.traps.map((t) => t.correct),
        ...Object.values(course.explainers ?? {}).flatMap((e) => sentencesOf(e.formal)),
        ...course.concepts.map((c) => c.description),
      ];
      for (const claim of truths) {
        checked += 1;
        const picked = scoreChunks(chunks, claim, { limit: 3 }).map((r) => r.chunk);
        if (checkClaim({ claim, chunks: picked, course, conceptId: null }).status === "contradicted") {
          flagged.push(`${course.id}: ${claim.slice(0, 90)}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(1900);
    expect(flagged.length / checked, `${flagged.length}/${checked}\n${flagged.join("\n")}`)
      .toBeLessThanOrEqual(FALSE_POSITIVE_RATE_CEILING);
    // Four thousand claim checks take a few seconds alone and longer with the
    // rest of the suite competing for the box, so this gets its own budget
    // rather than dying at the 5 s default and reading as a precision failure.
  }, 120_000);
});
