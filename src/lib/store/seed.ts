import { DEFAULT_COURSE_ID, getCourse } from "@/lib/courses";
import { blankMastery } from "@/lib/mastery";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

/**
 * The opening state of a brand-new browser: the default starter, with the
 * labelled starting map that ships with it (§11). Every number here comes from
 * the starter's own `priors`, so this file knows nothing about any one subject
 * and a different default starter needs no change in here.
 */
export const SEED_TIME = "2026-09-09T10:00:00.000Z";

export type SeedDoc = {
  userId: string;
  events: LearningEvent[];
  mastery: Record<string, ConceptMastery>;
  sessionId: string;
};

export function buildSeedDoc(userId: string): SeedDoc {
  const course = getCourse(DEFAULT_COURSE_ID);
  const mastery: Record<string, ConceptMastery> = {};
  for (const c of course.concepts) mastery[c.id] = blankMastery(c.id, SEED_TIME);
  for (const [conceptId, prior] of Object.entries(course.priors ?? {})) {
    const base = mastery[conceptId] ?? blankMastery(conceptId, SEED_TIME);
    const { recalled, ...fields } = prior;
    mastery[conceptId] = {
      ...base,
      ...fields,
      lastSuccessfulRecallAt: recalled ? SEED_TIME : base.lastSuccessfulRecallAt,
    };
  }

  // One remembered utterance so history is never empty. The sentence and the
  // passage it points at belong to the starter, not to this file.
  const opening = course.opening;
  const source = course.sources.find((s0) => s0.chunks.some((c) => c.id === opening?.chunkId));
  const chunk = source?.chunks.find((c) => c.id === opening?.chunkId);
  const events: LearningEvent[] = opening && source && chunk
    ? [{
        id: "evt_seed_001", userId, sessionId: `sess_demo::${userId}`,
        courseId: course.id, sourceId: source.id, createdAt: SEED_TIME,
        transcript: opening.text,
        cleanedTranscript: opening.text,
        origin: "voice", transcriptionConfidence: 0.97, transcriptionLatencyMs: 210,
        intent: "remember", conceptIds: [opening.conceptId], primaryConceptId: opening.conceptId,
        importance: 0.7, confusion: 0.1, confidenceSelfReport: null,
        sourceLocator: { section: chunk.locator.section, page: chunk.locator.page },
        interpretationConfidence: 0.85, evidenceIds: [chunk.id],
        requestedAction: "store", status: "grounded",
      }]
    : [];

  return { userId, events, mastery, sessionId: `sess_demo::${userId}` };
}
