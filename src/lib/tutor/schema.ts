import { z } from "zod";

/**
 * What a learner can be doing when they speak (Master prompt 5.1), plus
 * `hint` — asking for a nudge while a question is open. "I'm stuck" used to
 * fall through to `note` and come back "Noted.", which is the most dismissive
 * thing a tutor can say to a stuck student.
 */
export const TurnIntentSchema = z.enum(["confused", "claim", "explain", "quiz", "teach", "answer", "hint", "note"]);
export type TurnIntent = z.infer<typeof TurnIntentSchema>;

/** LLM confirmation of the first-pass reading. Falls back to the first pass. */
export const IntentConfirmSchema = z.object({
  intent: TurnIntentSchema,
  conceptIds: z.array(z.string().max(80)).max(6),
});
export type IntentConfirm = z.infer<typeof IntentConfirmSchema>;

/**
 * The tutor's reply (Master prompt 5.3). At most three parts, ≤ 90 words when
 * composed. `masterySignal` is a direction only — the number is written by
 * `src/lib/mastery.ts` and nowhere else.
 */
export const TutorReplySchema = z.object({
  right: z.string().max(200).nullable(),
  wrong: z.string().max(240).nullable(),
  question: z.string().max(200).nullable(),
  citations: z.array(z.object({ chunkId: z.string(), quote: z.string().max(160) })).max(2),
  misconception: z.string().max(160).nullable(),
  masterySignal: z.enum(["up", "down", "flat"]),
  strategy: z.enum(["probe", "contrast", "analogy", "recall", "teachback"]),
});
export type TutorReply = z.infer<typeof TutorReplySchema>;

/** One graded spoken answer (Master prompt 5.5). */
export const AssessmentReplySchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  correctPoints: z.array(z.string().max(160)).max(6),
  missingPoints: z.array(z.string().max(160)).max(6),
  possibleMisconception: z.string().max(240).nullable(),
  nextQuestion: z.string().max(200).nullable(),
  feedback: z.string().max(600),
});
export type AssessmentReply = z.infer<typeof AssessmentReplySchema>;
