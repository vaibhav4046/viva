import { CONCEPTS, DEMO_COURSE, DEMO_SOURCE } from "@/lib/course";
import { blankMastery } from "@/lib/mastery";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

/**
 * Shared demo seed: identical priors for every store backend (file/blob/pg).
 * Labeled demo data (§11) — realistic starting map, live utterances move it.
 */
export const SEED_TIME = "2026-09-09T10:00:00.000Z";

export type SeedDoc = {
  userId: string;
  events: LearningEvent[];
  mastery: Record<string, ConceptMastery>;
  sessionId: string;
};

export function buildSeedDoc(userId: string): SeedDoc {
  const mastery: Record<string, ConceptMastery> = {};
  for (const c of CONCEPTS) mastery[c.id] = blankMastery(c.id, SEED_TIME);
  mastery["c_self_attention"] = { ...mastery["c_self_attention"], exposureCount: 4, successfulRecallCount: 2, mastery: 0.68, confidence: 0.55, reviewPriority: 0.35, lastSuccessfulRecallAt: SEED_TIME };
  mastery["c_qkv"] = { ...mastery["c_qkv"], exposureCount: 3, successfulRecallCount: 1, confusionCount: 1, mastery: 0.58, confidence: 0.5, reviewPriority: 0.45, lastSuccessfulRecallAt: SEED_TIME };
  mastery["c_position"] = { ...mastery["c_position"], exposureCount: 2, confusionCount: 1, mastery: 0.44, confidence: 0.4, reviewPriority: 0.62 };
  mastery["c_multihead"] = { ...mastery["c_multihead"], exposureCount: 1, mastery: 0.5, confidence: 0.35, reviewPriority: 0.5 };
  void DEMO_COURSE;
  return {
    userId,
    events: [{
      id: "evt_seed_001", userId, sessionId: `sess_demo::${userId}`,
      courseId: DEMO_COURSE.id, sourceId: DEMO_SOURCE.id, createdAt: SEED_TIME,
      transcript: "Multi-head attention runs several attention computations in parallel.",
      cleanedTranscript: "Multi-head attention runs several attention computations in parallel.",
      origin: "voice", transcriptionConfidence: 0.97, transcriptionLatencyMs: 210,
      intent: "remember", conceptIds: ["c_multihead"], primaryConceptId: "c_multihead",
      importance: 0.7, confusion: 0.1, confidenceSelfReport: null,
      sourceLocator: { section: "4 · Multi-head attention", page: 15 },
      interpretationConfidence: 0.85, evidenceIds: ["ch_mh_1"],
      requestedAction: "store", status: "grounded",
    }],
    mastery,
    sessionId: `sess_demo::${userId}`,
  };
}
