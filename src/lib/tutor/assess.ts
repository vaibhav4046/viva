import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { SourceChunk } from "@/lib/types";
import { AssessmentReplySchema } from "./schema";
import type { ClaimCheck } from "./claim";
import { isFragmentAnswer, quotedHits, SAY_IT_AS_A_SENTENCE, scoreTeachback } from "./heuristic";

/**
 * Master prompt Appendix C, assessment.
 *
 * The keys are spelled out with their types for the same measured reason as
 * `TUTOR_SYSTEM` and `PLAN_SYSTEM`: a prompt that names the fields in prose
 * still leaves the model guessing whether `correctPoints` is a list or a
 * sentence, and a guess that comes back as a sentence fails the parse and
 * silently drops the turn to keyword grading.
 */
export const ASSESS_SYSTEM = [
  "You grade one spoken answer to a quiz question.",
  "Inputs: question, required points, hint, up to 3 passages, the answer.",
  "Reply with ONE JSON object with EXACTLY these six keys, every one present every time:",
  '{"verdict": "correct" | "partial" | "incorrect", "correctPoints": [string], "missingPoints": [string],',
  ' "possibleMisconception": string or null, "nextQuestion": string or null, "feedback": string}',
  "verdict = correct when every required point is there in substance, partial when some are, incorrect when none are or the answer contradicts the material.",
  "correctPoints and missingPoints = short phrases, at most 6 each, [] when there are none.",
  "possibleMisconception = the mistaken belief in one sentence, or null. nextQuestion = one probing question, or null.",
  "feedback = 60 words or fewer, second person.",
  "Judge substance, not wording. Do not penalise fillers or grammar.",
  // Measured: a nonsense sentence containing three of the marking words came
  // back "correct" with "you identified that without positional information a
  // Transformer cannot distinguish the order of tokens" — a description of
  // reasoning the learner never did. The server replaces correctPoints with
  // quotes of their own words; these lines stop the same invention in prose.
  "Credit only what the learner actually wrote. Never describe understanding they did not show, and never restate their sentence as if it were yours.",
  "Naming a required word is not making the point: an answer that is the required words with nothing around them is partial at best.",
  "If the answer says something the passages do not support, it is not correct however many required words it contains.",
  "Do not count what they missed and do not use the phrase \"required points\".",
].join(" ");

export type Graded = {
  verdict: "correct" | "partial" | "incorrect";
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
  nextQuestion: string | null;
  gradedBy: "model" | "keywords";
  /** The marking key. Routes reveal it only once the question is closed. */
  fullAnswerCovers: string[];
  /** How long the model took, or null when the keywords did the grading. */
  latencyMs: number | null;
};

export type GradeBaseline = Omit<Graded, "nextQuestion" | "gradedBy" | "fullAnswerCovers" | "latencyMs">;

function passageBlock(chunks: SourceChunk[]): string {
  if (chunks.length === 0) return "(no passages retrieved)";
  return chunks.map((c) => `[${c.id}] ${c.text.slice(0, 700)}`).join("\n");
}

/**
 * Grade one answer. The model does the judging, with the passages in front of
 * it; keyword coverage is the fallback when the model is unavailable and a
 * floor underneath it — an answer that affirms every required point does not
 * come back "incorrect", whatever the model says.
 *
 * Three things keyword coverage may NOT do, all of them measured failures:
 *
 *   - lift a verdict on an answer that is the marking words and nothing else.
 *     "order attention permutation" cleared the floor and was told CORRECT,
 *     which is a quiz a student can pass without knowing anything, and the map
 *     believes the result;
 *   - lift ANY verdict to "correct". It used to turn the model's "incorrect"
 *     into CORRECT whenever every required word was present, which is how "an
 *     attention weight is the number of tokens in the batch divided by the
 *     weight of the document" came back **correct above the model's own prose
 *     saying it did not state what an attention weight is** (S-A-01, measured
 *     on 13 Sep 2026). The floor now stops at "partial": not told they are
 *     wrong, not told they are right;
 *   - stand in for what the learner said. `correctPoints` is replaced with
 *     quotes of their own words, so "What was right" can never be a story
 *     about a student who understood.
 *
 * `check` is the deterministic read of the same passages (`checkClaim`). It
 * cannot make a verdict correct — only the model or a supporting line can do
 * that — but a contradiction in it removes "correct", because a verdict may
 * never be more generous than the source it was checked against.
 */
export async function gradeAnswer(input: {
  subject: string;
  question: string;
  requiredKeywords: string[];
  hint: string;
  answer: string;
  chunks: SourceChunk[];
  baseline: GradeBaseline;
  /** What the passages said, from `assessAnswer` or a direct `checkClaim`. */
  check: ClaimCheck;
}): Promise<Graded> {
  const user = [
    `Subject: ${input.subject}`,
    `Question: ${input.question}`,
    `Required points: ${input.requiredKeywords.join("; ") || "(none listed)"}`,
    `Hint: ${input.hint}`,
    `Passages:\n${passageBlock(input.chunks)}`,
    `Answer: ${input.answer}`,
  ].join("\n\n");

  const result = await reasonObject({
    system: ASSESS_SYSTEM,
    user,
    schema: AssessmentReplySchema,
    timeoutMs: REASON_TIMEOUT_MS.assessment,
  });
  if (!result) return { ...input.baseline, nextQuestion: null, gradedBy: "keywords", fullAnswerCovers: input.requiredKeywords, latencyMs: null };

  const r = result.value;
  const echo = isFragmentAnswer(input.answer, input.requiredKeywords);
  const covered = !echo && input.requiredKeywords.length > 0 && scoreTeachback(input.answer, input.requiredKeywords).coverage === 1;
  // The floor: naming every required point keeps an answer off "incorrect".
  // It stops there. Coverage has never read a passage.
  const floored = covered && r.verdict === "incorrect" ? "partial" : r.verdict;
  // The source contradicts it. Whatever the model made of the sentence, it is
  // not correct, and the learner gets the line that settles it.
  const overruled = floored === "correct" && input.check.status === "contradicted";
  const capped = overruled ? "incorrect" : floored;
  const verdict = echo && capped === "correct" ? "partial" : capped;
  return {
    verdict,
    // Their words or nothing. A paraphrase here is the app inventing a version
    // of the learner who understood and then congratulating him.
    correctPoints: quotedHits(input.answer, input.requiredKeywords),
    missingPoints: verdict === "correct" ? [] : r.missingPoints,
    // No misconception is read off an answer that stated nothing: a
    // one-word answer came back with a belief the learner never expressed.
    possibleMisconception:
      verdict === "correct" || echo ? null : overruled ? input.baseline.possibleMisconception : r.possibleMisconception,
    feedback: echo
      ? SAY_IT_AS_A_SENTENCE
      : // Overruled: the model's congratulation is not the sentence to print
        // over a contradiction. The keyword branch already wrote the honest
        // one, with the passage line inside it.
        overruled
        ? input.baseline.feedback
        : r.feedback.trim() || input.baseline.feedback,
    // Citations stay server-chosen: the model never names a passage id here.
    evidenceIds: input.baseline.evidenceIds,
    nextQuestion: r.nextQuestion,
    gradedBy: "model",
    fullAnswerCovers: input.requiredKeywords,
    latencyMs: result.latencyMs,
  };
}
