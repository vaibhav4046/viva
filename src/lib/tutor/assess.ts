import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { SourceChunk } from "@/lib/types";
import { AssessmentReplySchema } from "./schema";
import { scoreTeachback } from "./heuristic";

/** Master prompt Appendix C, assessment. */
const SYSTEM = [
  "You grade one spoken answer to a quiz question.",
  "Inputs: question, required points, hint, up to 3 passages, the answer.",
  'Output JSON: verdict (correct if all required points are present in substance, partial if some, incorrect if none or a contradiction), correctPoints, missingPoints, possibleMisconception (one sentence or null), feedback (60 words or fewer, second person, starts with what was right), nextQuestion (one probing question).',
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
};

export type GradeBaseline = Omit<Graded, "nextQuestion" | "gradedBy" | "fullAnswerCovers">;

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
    system: SYSTEM,
    user,
    schema: AssessmentReplySchema,
    timeoutMs: REASON_TIMEOUT_MS.assessment,
  });
  if (!result) return { ...input.baseline, nextQuestion: null, gradedBy: "keywords", fullAnswerCovers: input.requiredKeywords };

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
  };
}
