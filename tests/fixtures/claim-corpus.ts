import { compileTranscript } from "@/lib/compiler";
import { getCourse, type Course } from "@/lib/courses";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim, type ClaimCheck } from "@/lib/tutor/claim";
import { planTurn } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";

/**
 * The labelled corpus the claim checker is measured on.
 *
 * Written from an outside review of production on 13 Sep 2026: ten plainly
 * wrong sentences about the shipped Transformers subject, of which two were
 * contradicted and seven came back "I could not check that". The wrong half is
 * the recall target; the right half is the precision floor, and it matters
 * more — telling a student they are wrong when they are right is the failure
 * this file exists to prevent.
 *
 * `blocker` holds the sentence that was being marked wrong 5/5 before the
 * contrast words were added to the negation gate. Any change that brings it
 * back is a regression on a fix already verified live.
 */

export const TRANSFORMERS = getCourse("course_transformers_w4");

export function allChunks(course: Course): SourceChunk[] {
  return course.sources.flatMap((s) => s.chunks);
}

/** The same path /api/study/turn walks: compile → plan → retrieve → check. */
export function runClaim(course: Course, text: string): ClaimCheck {
  const draft = compileTranscript(text, { concepts: course.concepts });
  const plan = planTurn(draft, [], null);
  const query = [draft.cleanedTranscript, course.concepts.find((c) => c.id === plan.primaryConceptId)?.name ?? ""].join(" ");
  const chunks = scoreChunks(allChunks(course), query, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
  return checkClaim({ claim: draft.cleanedTranscript, chunks, course, conceptId: plan.primaryConceptId });
}

/** The reviewer's ten. `caught` records what production did on 13 Sep. */
export const WRONG: { id: string; text: string; wasCaught: boolean }[] = [
  { id: "w01-qk-same", text: "Queries and keys are the same vector in self-attention.", wasCaught: true },
  { id: "w02-pos-after-softmax", text: "Positional encoding is added to the attention weights after the softmax.", wasCaught: true },
  { id: "w03-mh-same-twice", text: "Multi-head attention just runs the same attention twice to make it faster.", wasCaught: false },
  { id: "w04-heads-redundant", text: "Attention heads all learn the same thing, they are redundant copies.", wasCaught: false },
  { id: "w05-pos-multiplied", text: "Positional encodings are multiplied with the attention scores.", wasCaught: false },
  { id: "w06-causal-only", text: "Self-attention only lets a token look at the tokens before it.", wasCaught: false },
  { id: "w07-query-value-same", text: "The query and the value are always identical vectors.", wasCaught: false },
  { id: "w08-pos-long-only", text: "Positional encoding is only needed for very long sequences.", wasCaught: false },
  { id: "w09-recurrence", text: "Transformers use recurrence to track word order.", wasCaught: false },
  { id: "w10-not-permutation", text: "Self-attention is not permutation invariant, so positional encoding is unnecessary.", wasCaught: false },
];

/** Ten right sentences about the same subject. None may be contradicted. */
export const RIGHT: { id: string; text: string }[] = [
  { id: "r01", text: "Multi-head attention runs several heads in parallel, each in a smaller subspace." },
  { id: "r02", text: "Different attention heads specialise in different relation types." },
  { id: "r03", text: "Positional encodings are added to the token embeddings." },
  { id: "r04", text: "Self-attention without positional information is permutation-equivariant." },
  { id: "r05", text: "The attention score is the dot product of a query and a key, scaled by the square root of the key dimension." },
  { id: "r06", text: "Queries ask, keys advertise, and values deliver the content they carry forward." },
  { id: "r07", text: "Backpropagation computes the gradients and gradient descent uses them to update the weights." },
  { id: "r08", text: "Policy iteration alternates policy evaluation and policy improvement." },
  { id: "r09", text: "Value iteration applies the Bellman optimality update directly at every sweep." },
  { id: "r10", text: "Self-attention lets every token compare itself with every other token in the sequence." },
];

/**
 * The blocker fix and its variants. "Backpropagation and gradient descent are
 * two different steps" was marked wrong 5/5 before the contrast words went
 * into the negation gate; these are the sentences that regression would show
 * up in first.
 */
export const CONTRAST_CONTROLS: { id: string; text: string }[] = [
  { id: "b01-blocker", text: "Backpropagation and gradient descent are two different steps." },
  { id: "b02", text: "Backpropagation and gradient descent are different things." },
  { id: "b03", text: "Backpropagation differs from gradient descent." },
  { id: "b04", text: "Backpropagation is distinct from gradient descent." },
  { id: "b05", text: "Backpropagation and gradient descent are separate steps in training." },
  { id: "b06", text: "Backprop computes the direction rather than deciding how far to move." },
  { id: "b07", text: "Queries, keys and values are three separate projections of each token." },
  { id: "b08", text: "Positional encoding supplies order rather than importance." },
  { id: "b09", text: "Value iteration folds improvement into the update instead of alternating two steps." },
  { id: "b10", text: "A query and a key are different projections, unlike a value which carries content." },
];

/** Reading a line straight off the page must not score as recall. */
export const PARROT: { id: string; text: string }[] = [
  { id: "p01", text: "A single attention head computes one weighted average, which bottlenecks what it can express." },
  { id: "p02", text: "Positional encodings are added to the token embeddings so that 'dog bites man' and 'man bites dog' produce different representations." },
];

/**
 * Wrong, and phrased with a contrast word. These are what the split between
 * denial and contrast buys: under the wide gate every one of them skipped all
 * six checks on the strength of "instead of" / "rather than" alone.
 */
export const CONTRAST_WRONG: { id: string; text: string }[] = [
  { id: "c01", text: "Positional encodings are multiplied with the attention scores instead of the token embeddings." },
  { id: "c02", text: "Queries and keys are the same vector rather than two projections." },
];
