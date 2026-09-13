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
  HELD_OUT_TRUE,
  runClaim,
} from "./fixtures/claim-corpus";

/**
 * How much of what a student gets wrong VIVA actually catches, and — the half
 * that matters more — how often it corrects somebody who was right.
 *
 * This header used to say the corpus was fixed before the fix. Git does not
 * support that: the fixture, this test and the change to `claim.ts` all landed
 * in one commit, `f127cca`. An audit then measured what that costs — five of
 * the seven catches had a bespoke lexical lever added in the same diff, two
 * keyed on words that appear nowhere else in the shipped library — and wrote a
 * genuinely held-out set of true sentences. **Six of its fourteen were
 * contradicted.** Two strategies were narrowed to fix that, and three real
 * catches were lost doing it.
 *
 * Measured, both directions:
 *
 *   wrong caught          2/10 → 7/10 (fitted) → 4/10 (after narrowing)
 *   wrong-with-contrast   0/2  → 2/2 → 1/2
 *   right contradicted    0/20 → 0/20
 *   HELD-OUT true sentences contradicted   6/14 → 0/14
 *   every true sentence VIVA ships (3910)  27 → 26 contradicted
 *
 * 4/10 with nothing false is the honest number and the one to quote. A miss is
 * answered with "I could not check that"; a false positive tells a student
 * they are wrong when they are right. Raise recall only against the held-out
 * set, never against the fitted one.
 *
 * 13 Sep, second pass, after a student judge got the "I could not check that"
 * line for nine claims out of ten. That round moved only the SUPPORT check —
 * the one exit that may tell a learner they are right — and moved nothing in
 * the contradiction strategies:
 *
 *   two-line verbatim quote of the open passage   missed → confirmed
 *   wrong caught                                  5/10 → 5/10 (unchanged)
 *   right contradicted                            0/22 → 0/22
 *   HELD-OUT true sentences contradicted          0/14 → 0/14
 *   every true sentence VIVA ships (3910)         26 → 26 contradicted
 *   every FALSE sentence the library ships (65)   0 → 0 confirmed
 *
 * The last row is the new negative set and the one that decided every
 * threshold in `supportedBy`: the library's own trap statements, sixty-five
 * sentences twenty-six subject authors wrote down as mistakes. Two widenings
 * that would have reached further were measured and rejected against it, and
 * both are recorded below the recall block.
 */

const CAUGHT = new Set([
  "w01-qk-same",
  "w02-pos-after-softmax",
  "w04-heads-redundant",
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
const STILL_MISSED = new Set([
  "w06-causal-only",
  "w08-pos-long-only",
  "w10-not-permutation",
  // Given up deliberately, to stop the product contradicting true sentences.
  // w03 was caught by a uniformity rule that fired on any passage line holding
  // a contrast word, which also contradicted "All the heads read the same
  // input embeddings" and "So um the heads are all the same size I think".
  // w05 was caught by a verb-class clash that also contradicted "Positional
  // encodings are scaled by a constant factor" — a vector can be scaled and
  // added, so that was never a contradiction. Both are recorded here rather
  // than deleted: they are recall we would like back, on evidence, from a rule
  // that reads meaning instead of shape.
  "w03-mh-same-twice",
  "w05-pos-multiplied",
]);

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

  it("catches at least four of the ten, and improving that is allowed", () => {
    const hits = WRONG.filter((w) => runClaim(TRANSFORMERS, w.text).status === "contradicted");
    // A floor, not a snapshot. This was exact set equality, which went red if
    // recall *improved* — a pin wearing a ratchet's name. Raise the floor when
    // a change earns it; never lower it to make a gate green.
    expect(hits.length).toBeGreaterThanOrEqual(4);
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
  // c01 is the contrast phrasing of w05 and went with it when the verb-class
  // clash was narrowed. Kept in the corpus, asserted as a miss, for the same
  // reason: it is a debt, not a decision to forget.
  const CONTRAST_MISSED = new Set(["c01"]);
  for (const c of CONTRAST_WRONG) {
    it(`${CONTRAST_MISSED.has(c.id) ? "does not yet catch" : "catches"} ${c.id}`, () => {
      const status = runClaim(TRANSFORMERS, c.text).status;
      if (CONTRAST_MISSED.has(c.id)) {
        expect(status).not.toBe("contradicted");
        expect(status).not.toBe("supported");
      } else {
        expect(status).toBe("contradicted");
      }
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

/**
 * The three shapes a student judge typed into the main box on 13 Sep, of which
 * nine claims in ten came back "I could not check that against your source"
 * while the passage that settled them was on screen. What each one measured,
 * and why it now does what it does:
 *
 *   a. a near-verbatim quote of two consecutive lines of the open passage.
 *      Was `consistent`. The support check scored the whole two-sentence claim
 *      against ONE passage line and got 0.75 against a bar of 0.80 — neither
 *      half of what the student said could ever cover the whole of it. Each
 *      sentence now finds its own line and all of them must.
 *   b. the same passage in the student's own words ("shuffle" for "permute",
 *      and the source's "without position information" dropped). Still a miss,
 *      and deliberately: it covers 0.89 of its best line's words but only 0.33
 *      of its adjacent pairs, and that line carries a denial the claim does
 *      not. Relaxing both to reach it was measured — it endorses two labelled
 *      -false sentences the library ships, including "A light-year is a unit
 *      of time, not distance". A miss says "I could not check that"; that
 *      would say "correct" to a student who is wrong.
 *   c. flatly false, and refuted by the passage beside it. Still a miss. Every
 *      strategy here is lexical and this sentence shares its whole vocabulary
 *      with the lines that disprove it; nothing in the shape separates them.
 *      The upgrade is a model pass over the same passages, not another regex.
 */
describe("the shapes a student actually typed", () => {
  const QUOTE =
    "Each token is projected into three vectors: a query, a key and a value. " +
    "The attention score between token i and token j is the dot product of query i and key j, " +
    "scaled by the square root of the key dimension.";

  it("confirms a claim quoted out of two consecutive passage lines", () => {
    const check = runClaim(TRANSFORMERS, QUOTE);
    expect(check.status).toBe("supported");
    // The confirmation shows the line it rests on or it is just a compliment.
    expect(check.quote).toBeTruthy();
    expect(check.chunkId).toBeTruthy();
  });

  it("will not confirm a paragraph on the strength of one true sentence in it", () => {
    const check = runClaim(TRANSFORMERS, `${QUOTE} Positional encoding is applied after the softmax.`);
    expect(check.status).not.toBe("supported");
  });

  it("still says so honestly on the two it cannot read", () => {
    for (const text of [
      "self attention is permutation equivariant so if i shuffle the tokens the outputs shuffle the same way",
      "multi head attention means you run the whole transformer eight times and average the eight outputs at the end",
    ]) {
      const check = runClaim(TRANSFORMERS, text);
      expect(check.status).not.toBe("supported");
      expect(check.status).not.toBe("contradicted");
    }
  });
});

/**
 * The other direction of the same promise, and the set that did not exist
 * before: every sentence the library ships that its own author labelled WRONG.
 * Sixty-five of them across twenty-six subjects, none of which VIVA may agree
 * with. Widening the support check is the change that could break this, and it
 * has already tried twice — dropping the word floor from six to five endorses
 * "Ionic compounds are made of covalent bonds", and dropping the pair floor
 * endorses "A light-year is a unit of time, not distance", which shares five
 * of its six words with a line that says the opposite.
 */
describe("never agrees with a sentence the subject calls a mistake", () => {
  it("supports none of the traps the library ships", () => {
    const seen = new Set<string>();
    const endorsed: string[] = [];
    let checked = 0;
    for (const course of [...Object.values(COURSES), ...CORPUS] as Course[]) {
      if (seen.has(course.id)) continue;
      seen.add(course.id);
      const chunks = everyChunk(course);
      for (const trap of course.traps) {
        checked += 1;
        const picked = scoreChunks(chunks, trap.statement, { limit: 3 }).map((r) => r.chunk);
        if (checkClaim({ claim: trap.statement, chunks: picked, course, conceptId: null }).status === "supported") {
          endorsed.push(`${course.id}: ${trap.statement}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(endorsed, endorsed.join(" | ")).toEqual([]);
  }, 60_000);

  it("supports none of the ten wrong sentences either", () => {
    const endorsed = [...WRONG, ...CONTRAST_WRONG].filter((w) => runClaim(TRANSFORMERS, w.text).status === "supported");
    expect(endorsed.map((w) => w.id)).toEqual([]);
  });
});

describe("held out: sentences the checker was not written against", () => {
  /*
   * The corpus above landed in the same commit as the code it measures, so its
   * recall number is fitted by construction. This block is the counterweight
   * and it is the one that must never go red: an auditor wrote these after the
   * fact, and six of the fourteen were contradicted on first run.
   *
   * Narrowing two strategies to fix that cost three genuine catches, 7/10 down
   * to 4/10. That trade is deliberate and is recorded here so nobody quietly
   * reverses it: a miss is answered with "I could not check that", which is
   * honest, and a false positive tells a student they are wrong when they are
   * right, which is the one thing this product may never do.
   */
  for (const h of HELD_OUT_TRUE) {
    it(`never contradicts ${h.id}`, () => {
      const check = runClaim(TRANSFORMERS, h.text);
      expect(check.status, `"${h.text}" — ${check.lead ?? ""}`).not.toBe("contradicted");
    });
  }

  it("stays silent rather than agreeing when it cannot check", () => {
    // The other half of honesty: not contradicting must not become endorsing.
    const affirmed = HELD_OUT_TRUE
      .map((h) => ({ h, c: runClaim(TRANSFORMERS, h.text) }))
      .filter(({ c }) => c.status === "supported" && !c.chunkId);
    expect(affirmed.map((a) => a.h.id)).toEqual([]);
  });
});
