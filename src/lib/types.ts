import { z } from "zod";

export const LearningIntentSchema = z.enum([
  "confusion",
  "remember",
  "question",
  "claim",
  "teachback",
  "quiz_request",
  "explain",
  "compare",
  "exam_marker",
  "review_request",
  "connection",
  "correction",
  // Asking for a nudge is a thing the learner DID, not a thing they claimed.
  // Without it, "give me a hint" compiled to a note and was filed against a
  // passage as though it were a statement about that passage.
  "hint",
  "note",
]);
export type LearningIntent = z.infer<typeof LearningIntentSchema>;

export const LearningEventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  courseId: z.string().nullable(),
  sourceId: z.string().nullable(),
  createdAt: z.string(),
  transcript: z.string(),
  cleanedTranscript: z.string(),
  origin: z.enum(["voice", "typed"]).default("voice"),
  transcriptionConfidence: z.number().nullable(),
  transcriptionLatencyMs: z.number().nullable(),
  intent: LearningIntentSchema,
  conceptIds: z.array(z.string()),
  primaryConceptId: z.string().nullable(),
  importance: z.number().min(0).max(1),
  confusion: z.number().min(0).max(1),
  confidenceSelfReport: z.number().nullable(),
  sourceLocator: z
    .object({
      page: z.number().optional(),
      section: z.string().optional(),
      timestampSeconds: z.number().optional(),
      selection: z.string().optional(),
    })
    .nullable(),
  interpretationConfidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()),
  requestedAction: z.enum(["store", "explain", "quiz", "compare", "review", "evaluate", "none"]),
  status: z.enum(["captured", "compiled", "grounded", "responded", "failed"]),
  /** Additive outcome fields — replayable per-event evidence of what happened. */
  assessment: z.enum(["correct", "partial", "incorrect"]).nullable().optional(),
  delta: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;

export const ConceptMasterySchema = z.object({
  conceptId: z.string(),
  exposureCount: z.number(),
  successfulRecallCount: z.number(),
  failedRecallCount: z.number(),
  confusionCount: z.number(),
  misconceptionCount: z.number(),
  teachbackScoreAvg: z.number().nullable(),
  lastSeenAt: z.string(),
  lastSuccessfulRecallAt: z.string().nullable(),
  mastery: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reviewPriority: z.number().min(0).max(1),
});
export type ConceptMastery = z.infer<typeof ConceptMasterySchema>;

export const SourceChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  ordinal: z.number(),
  text: z.string(),
  locator: z.object({
    page: z.number().optional(),
    section: z.string().optional(),
  }),
});
export type SourceChunk = z.infer<typeof SourceChunkSchema>;

export const EvidenceVerdictSchema = z.object({
  support: z.array(z.string()),
  contradiction: z.array(z.string()),
  insufficient: z.array(z.string()),
  coverage: z.number().min(0).max(1),
  sourceRequired: z.boolean(),
});
export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;

export function err(code: string, message: string, retryable = true, status = 400) {
  return Response.json({ error: { code, message, retryable } }, { status });
}

export function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
