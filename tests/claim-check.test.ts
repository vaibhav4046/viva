import { describe, expect, it } from "vitest";
import { compileTranscript } from "@/lib/compiler";
import { COURSES, getCourse, type Course } from "@/lib/courses";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim, composeClaimReply } from "@/lib/tutor/claim";
import { planTurn } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";

/**
 * Both directions of the claim check, on the two starter subjects.
 *
 * The failure this file exists for is asymmetric: missing a wrong claim costs
 * a teaching moment, but contradicting a RIGHT claim tells a student who
 * understands the material that they do not, and docks their mastery for it.
 * So every case below is paired — the mistake and its correct refutation.
 */

const TRANSFORMERS = getCourse("course_transformers_w4");
const PROBABILITY = getCourse("course_probability");

function allChunks(course: Course): SourceChunk[] {
  return course.sources.flatMap((s) => s.chunks);
}

/** The same path /api/study/turn walks: compile → plan → retrieve → check. */
function run(course: Course, text: string) {
  const draft = compileTranscript(text, { concepts: course.concepts });
  const plan = planTurn(draft, [], null);
  const query = [draft.cleanedTranscript, course.concepts.find((c) => c.id === plan.primaryConceptId)?.name ?? ""].join(" ");
  const chunks = scoreChunks(allChunks(course), query, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
  return { plan, check: checkClaim({ claim: draft.cleanedTranscript, chunks, course, conceptId: plan.primaryConceptId }) };
}

describe("a stated belief reaches the checker at all", () => {
  // The old gate was a verb whitelist (is/are/means/…), so any sentence built
  // on another verb — "uses", "alternates", "runs" — was filed unchecked.
  const declaratives = [
    "Multi-head attention uses one head per layer.",
    "Value iteration alternates policy evaluation and policy improvement.",
    "Queries and keys are the same vector in self-attention.",
    "The attention score is scaled by the square root of the number of heads.",
  ];
  for (const text of declaratives) {
    it(`treats "${text.slice(0, 40)}…" as a claim, not a note`, () => {
      expect(run(TRANSFORMERS, text).plan.intent).toBe("claim");
    });
  }

  it("still treats a question as a question", () => {
    expect(run(TRANSFORMERS, "What is multi-head attention for?").plan.intent).not.toBe("claim");
  });
});

describe("wrong claims the source itself flags", () => {
  const wrong: [string, string][] = [
    ["one head per layer", "Multi-head attention uses one head per layer."],
    ["policy vs value iteration", "Value iteration alternates policy evaluation and policy improvement."],
    ["queries and keys conflated", "Queries and keys are the same vector in self-attention."],
    ["sqrt of heads, not key dim", "The attention score is scaled by the square root of the number of heads."],
    ["backprop is gradient descent", "Backpropagation and gradient descent are the same thing."],
    ["order vs importance", "Positional encoding only adds cosmetic detail because attention weights already encode which words are important."],
    ["encoding after the softmax", "Positional encoding is added to the attention weights after the softmax."],
  ];
  for (const [name, text] of wrong) {
    it(`catches ${name}`, () => {
      const { check } = run(TRANSFORMERS, text);
      expect(check.status).toBe("contradicted");
      // A correction with nothing to show for it is a lecture, not a check.
      expect(check.quote).toBeTruthy();
      expect(check.chunkId).toBeTruthy();
    });
  }

  it("catches the probability trap", () => {
    const { check } = run(PROBABILITY, "Mutually exclusive events are independent.");
    expect(check.status).toBe("contradicted");
  });
});

describe("correct claims are never contradicted", () => {
  const right: [string, Course, string][] = [
    ["refutes the trap with 'cannot'", PROBABILITY, "Independence means P(A and B) = P(A)P(B), so mutually exclusive events with positive probability cannot be independent."],
    ["refutes the trap with 'can't'", PROBABILITY, "Mutually exclusive events with positive probability can't be independent."],
    ["refutes the trap with 'not'", PROBABILITY, "Mutually exclusive events are not independent when both have positive probability."],
    ["refutes the trap with 'never'", PROBABILITY, "Mutually exclusive events with positive probability are never independent."],
    ["refutes the trap with 'won't'", PROBABILITY, "Two mutually exclusive events with positive probability won't be independent."],
    ["conditional probability is not symmetric", PROBABILITY, "P(A given B) and P(B given A) are not the same quantity."],
    ["backprop differs from gradient descent", TRANSFORMERS, "Backpropagation is different from gradient descent because gradient descent is the optimiser."],
    ["states the real scaling", TRANSFORMERS, "The attention score is scaled by the square root of the key dimension."],
    ["states the real head count", TRANSFORMERS, "Multi-head attention runs several heads in parallel in each layer."],
    ["restates a passage sentence", TRANSFORMERS, "A single attention head computes one weighted average, which bottlenecks what it can express."],
    ["states what positional information adds", TRANSFORMERS, "Positional information supplies sequence order, and attention without it is permutation-equivariant."],
    ["states policy iteration correctly", TRANSFORMERS, "Policy iteration alternates policy evaluation and policy improvement."],
    ["keys and values are separate", TRANSFORMERS, "Queries, keys and values are three separate projections of each token."],
  ];
  for (const [name, course, text] of right) {
    it(`leaves alone: ${name}`, () => {
      expect(run(course, text).check.status).not.toBe("contradicted");
    });
  }
});

describe("off-topic and unsupported", () => {
  it("says a claim is not in this subject rather than filing it", () => {
    const { check } = run(TRANSFORMERS, "Paris is the capital of Germany.");
    expect(check.status).toBe("unsupported");
    expect(check.lead).toMatch(/not in this subject/i);
  });

  it("does not cite a passage it could not check against", () => {
    const { check } = run(TRANSFORMERS, "Paris is the capital of Germany.");
    expect(check.quote).toBeNull();
    expect(check.chunkId).toBeNull();
  });

  it("never claims the source agrees", () => {
    for (const course of Object.values(COURSES)) {
      for (const chunk of allChunks(course)) {
        const reply = composeClaimReply(
          checkClaim({ claim: chunk.text.slice(0, 120), chunks: [chunk], course, conceptId: null }),
          "this"
        );
        expect(reply).not.toMatch(/nothing (?:in|contradicts)/i);
        expect(reply).not.toMatch(/is right|is correct|agrees/i);
      }
    }
  });
});

describe("every authored trap survives its own refutation", () => {
  for (const course of Object.values(COURSES)) {
    for (const trap of course.traps) {
      it(`${course.code}: a correct answer to ${trap.id} is not contradicted`, () => {
        const chunks = allChunks(course);
        const check = checkClaim({ claim: trap.correct, chunks, course, conceptId: trap.conceptId });
        expect(check.status).not.toBe("contradicted");
      });
      it(`${course.code}: stating ${trap.id} is contradicted`, () => {
        const chunks = allChunks(course);
        const check = checkClaim({ claim: trap.statement, chunks, course, conceptId: trap.conceptId });
        expect(check.status).toBe("contradicted");
      });
    }
  }
});
