import type { Subject } from "@/lib/courses/types";
import type { ConceptMastery, LearningEvent, LearningIntent, SourceChunk } from "@/lib/types";

/**
 * EventStore — the durable spine. Append-only events; derived mastery.
 * Every method takes userId; implementations MUST scope all access (§15).
 */

export type RecordInput = {
  idempotencyKey: string;
  sessionId: string;
  courseId: string | null;
  sourceId: string | null;
  transcript: string;
  cleanedTranscript: string;
  origin: "voice" | "typed" | "external-dictation";
  transcriptionConfidence: number | null;
  transcriptionLatencyMs: number | null;
  transcriptionSessionId: string | null;
  /** Which endpoint answered, the one it fell back from, and what it heard. */
  transcriptionMode?: "dictation" | "sync" | null;
  transcriptionFellBackFrom?: "dictation" | "sync" | null;
  transcriptVerbatim?: string | null;
  intent: LearningIntent;
  conceptIds: string[];
  primaryConceptId: string | null;
  importance: number;
  confusion: number;
  interpretationConfidence: number;
  evidenceIds: string[];
  requestedAction: LearningEvent["requestedAction"];
  status: LearningEvent["status"];
  sourceLocator: LearningEvent["sourceLocator"];
  assessment?: "correct" | "partial" | "incorrect" | null;
  teachbackScore?: number | null;
  /** Direction from the tutor; the number is still computed in mastery.ts. */
  masterySignal?: "up" | "down" | "flat" | null;
  /** The hint text the learner was shown for the question they answered. */
  hint?: string | null;
  /**
   * When this happened, when the caller knows better than the clock here.
   * Only a replay does: the browser holds a record made minutes or days ago,
   * and stamping it "now" on the way back in would rewrite the learner's
   * history to say everything happened two seconds ago. Omit it and the store
   * uses its own clock, which is right for every live turn.
   */
  createdAt?: string | null;
};

export type RecordOutcome = {
  event: LearningEvent;
  mastery: Record<string, ConceptMastery>;
  delta: number | null;
  reason: string | null;
  duplicate: boolean;
};

export type ConceptDef = {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  related: string[];
};

/** Count-only product instrumentation — never transcripts, never PII. */
export type ProductEventSummary = { name: string; count: number };

export interface EventStore {
  readonly backend: "postgres" | "file" | "blob";
  ensureUser(userId: string, displayName?: string): Promise<void>;
  /** Seed one starter's material (sources, concepts) for this user. */
  seedCourse(userId: string, courseId: string): Promise<void>;
  /** Persist a subject this user built from their own notes. */
  saveSubject(userId: string, subject: Subject): Promise<void>;
  /** The caller's own subject, or null. Never another user's. */
  getSubject(userId: string, subjectId: string): Promise<Subject | null>;
  /** Every subject this user built. Starters are not included. */
  listSubjects(userId: string): Promise<Subject[]>;
  /** Delegating alias for the default lab (Transformers). */
  seedDemoCourse(userId: string): Promise<void>;
  recordLearning(userId: string, input: RecordInput): Promise<RecordOutcome>;
  listEvents(userId: string, limit?: number): Promise<LearningEvent[]>;
  getMastery(userId: string): Promise<Record<string, ConceptMastery>>;
  getCourseChunks(userId: string, courseId?: string): Promise<SourceChunk[]>;
  getConcepts(userId: string, courseId?: string): Promise<ConceptDef[]>;
  retrieveEvidence(userId: string, query: string, opts?: { sourceId?: string | null; conceptIds?: string[]; limit?: number; courseId?: string }): Promise<{ chunk: SourceChunk; score: number }[]>;
  enqueueReview(userId: string, conceptId: string, priority: number, reason: string): Promise<void>;
  saveTutorMessage(userId: string, sessionId: string, role: "user" | "assistant", content: string, evidenceIds: string[]): Promise<void>;
  addSource(userId: string, input: { title: string; type: string; chunks: { text: string; section: string; page?: number }[]; courseId?: string }): Promise<{ sourceId: string; chunkIds: string[] }>;
  getReviewQueue(userId: string): Promise<{ conceptId: string; dueAt: string; priority: number; reason: string }[]>;
  /** Best-effort retention instrumentation: { name, fields } only, no content. */
  recordProductEvent(userId: string, name: string, fields?: Record<string, number | string | boolean>): Promise<void>;
  /** Aggregated counts per event name over the last `days` days. */
  productEventSummary(userId: string, days?: number): Promise<ProductEventSummary[]>;
  deleteUserData(userId: string): Promise<void>;
}
