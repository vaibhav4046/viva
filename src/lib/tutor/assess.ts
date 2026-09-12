import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { SourceChunk } from "@/lib/types";
import { AssessmentReplySchema } from "./schema";
import { scoreTeachback } from "./heuristic";

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
  "feedback = 60 words or fewer, second person, starts with what was right.",
  "Judge substance, not wording. Do not penalise fillers or grammar.",
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
 * Grade one answer. The model does the judging; keyword coverage is both the
 * fallback when the model is unavailable and a floor underneath it — an answer
 * that affirms every required point can never come back "incorrect", whatever
 * the model says.
 */
export async function gradeAnswer(input: {
  subject: string;
  question: string;
  requiredKeywords: string[];
  hint: string;
  answer: string;
  chunks: SourceChunk[];
  baseline: GradeBaseline;
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
  const covered = input.requiredKeywords.length > 0 && scoreTeachback(input.answer, input.requiredKeywords).coverage === 1;
  const verdict = covered && r.verdict === "incorrect" ? "correct" : r.verdict;
  return {
    verdict,
    correctPoints: r.correctPoints.length > 0 ? r.correctPoints : input.baseline.correctPoints,
    missingPoints: verdict === "correct" ? [] : r.missingPoints,
    possibleMisconception: verdict === "correct" ? null : r.possibleMisconception,
    feedback: r.feedback.trim() || input.baseline.feedback,
    // Citations stay server-chosen: the model never names a passage id here.
    evidenceIds: input.baseline.evidenceIds,
    nextQuestion: r.nextQuestion,
    gradedBy: "model",
    fullAnswerCovers: input.requiredKeywords,
    latencyMs: result.latencyMs,
  };
}
