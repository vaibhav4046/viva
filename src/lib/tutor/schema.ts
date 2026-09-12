import { z } from "zod";

/**
 * What a learner can be doing when they speak (Master prompt 5.1), plus
 * `hint` — asking for a nudge while a question is open. "I'm stuck" used to
 * fall through to `note` and come back "Noted.", which is the most dismissive
 * thing a tutor can say to a stuck student.
 */
export const TurnIntentSchema = z.enum(["confused", "claim", "explain", "quiz", "teach", "answer", "hint", "note"]);
export type TurnIntent = z.infer<typeof TurnIntentSchema>;

/**
 * A display budget, not a gate: clip what is over rather than throwing the
 * whole reply away.
 *
 * These were `.max(n)`, and measured against the live provider that cost the
 * learner real answers — three of four probes came back correct, grounded and
 * properly keyed, and were rejected because one quote ran 166 characters
 * against a 160 cap. A six-character overrun triggered a repair round trip and
 * then a silent drop to the heuristic path. The rule that actually protects
 * the student is `groundReply`, which deletes any citation whose chunkId is
 * not one of the retrieved passages; length is only how much fits on a card.
 *
 * `clip` is exported because the intake schemas clip for the same reason, and
 * two spellings of the same budget is how the "…" ends up in one place only.
 */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const clipped = (max: number) => z.string().transform((s) => clip(s, max));

/**
 * LLM confirmation of the first-pass reading. Falls back to the first pass.
 *
 * Both caps trim rather than refuse: `confirmPlan` keeps only the ids that are
 * actually in the subject, so a seventh id or an over-long one costs nothing,
 * while refusing the object costs the whole confirmation.
 */
export const IntentConfirmSchema = z.object({
  intent: TurnIntentSchema,
  conceptIds: z.array(clipped(80)).transform((ids) => ids.slice(0, 6)),
});
export type IntentConfirm = z.infer<typeof IntentConfirmSchema>;


/**
 * The tutor's reply (Master prompt 5.3). At most three parts, ≤ 90 words when
 * composed. `masterySignal` is a direction only — the number is written by
 * `src/lib/mastery.ts` and nowhere else.
 */
export const TutorReplySchema = z.object({
  right: clipped(200).nullable(),
  wrong: clipped(240).nullable(),
  question: clipped(200).nullable(),
  citations: z
    .array(z.object({ chunkId: z.string(), quote: clipped(160) }))
    .transform((c) => c.slice(0, 2)),
  misconception: clipped(160).nullable(),
  masterySignal: z.enum(["up", "down", "flat"]),
  strategy: z.enum(["probe", "contrast", "analogy", "recall", "teachback"]),
});
export type TutorReply = z.infer<typeof TutorReplySchema>;

/** One graded spoken answer (Master prompt 5.5). Same budgets, same clipping. */
export const AssessmentReplySchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  correctPoints: z.array(clipped(160)).transform((a) => a.slice(0, 6)),
  missingPoints: z.array(clipped(160)).transform((a) => a.slice(0, 6)),
  possibleMisconception: clipped(240).nullable(),
  nextQuestion: clipped(200).nullable(),
  feedback: clipped(600),
});
export type AssessmentReply = z.infer<typeof AssessmentReplySchema>;
