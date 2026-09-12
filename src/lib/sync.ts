import { z } from "zod";
import { listSubjectsFor, resolveSubject } from "@/lib/courses/subject";
import type { Subject } from "@/lib/courses/types";
import { LearningIntentSchema } from "@/lib/types";
import { learnerDNA, storeDurability } from "@/lib/store";
import type { EventStore } from "@/lib/store/repo";

/**
 * Reconciliation: the browser holds the learner's record, this file merges it back.
 *
 * There is no database behind this deployment. Learner state lives in one
 * lambda's /tmp, so two page loads are two different memories of the same
 * student: measured on the live site, four of ten reads of one student's own
 * record on one cookie came back empty in the same second. So the browser is
 * the authority and the server is a warm cache — the client mirrors every
 * mutation locally and hands the record back on load, and this merges it.
 *
 * The merge has exactly one rule that matters: it must be safe to run twice.
 * Every mutation the app makes already carries a `clientEventId`, which the
 * stores use as their idempotency key, so a replayed event is recognised and
 * dropped rather than folded a second time. That is why this file does NOT
 * accept the client's mastery numbers: it replays the events and lets the same
 * fold in `src/lib/mastery.ts` recompute the map, so a student who reloads
 * twice cannot move their own mastery.
 *
 * Be precise about what that is and is not. It means the arithmetic is ours
 * and a client cannot hand us a number. It does NOT mean a client cannot
 * influence its own map: a replayed event carries the assessment the server
 * produced when it graded the turn, and nothing here can tell that apart from
 * a fabricated one, so anyone posting hand-written events can walk their own
 * bands wherever they like. That is accepted, not overlooked. The whole design
 * makes the browser the authority for its own record because there is no
 * database to be the authority instead, and the only thing a student wins by
 * lying to it is a study plan that skips what they do not know. It is their
 * account and nobody else's: `resolveIdentity` scopes every write to the
 * cookie, so no replay can reach another learner's map.
 */

/** One request may not carry more than this. Bounded on purpose (§ below). */
export const MAX_SYNC_EVENTS = 200;
export const MAX_SYNC_SUBJECTS = 10;
export const MAX_SYNC_BYTES = 512_000;
/** A replayed timestamp older than this is a clock that cannot be trusted. */
const MAX_AGE_MS = 400 * 24 * 3600 * 1000;

const Id = z.string().regex(/^[A-Za-z0-9_:.-]{1,80}$/);
const Unit = z.number().min(0).max(1);

/**
 * One mirrored event, replayed.
 *
 * Deliberately the same shape every mutating route already returns as `event`,
 * plus `clientEventId`. The browser stores `{...json.event, clientEventId}` and
 * posts that object straight back; unknown keys are ignored rather than
 * refused, so the client never has to strip anything.
 */
export const ReplayEventSchema = z.object({
  clientEventId: z.string().min(1).max(80),
  /** `createdAt` is what the event carries; `at` is accepted as an alias. */
  createdAt: z.string().min(4).max(40).optional(),
  at: z.string().min(4).max(40).optional(),
  sessionId: z.string().max(80).optional(),
  courseId: Id.nullable().optional(),
  sourceId: Id.nullable().optional(),
  intent: LearningIntentSchema,
  conceptIds: z.array(Id).max(6).optional(),
  primaryConceptId: Id.nullable().optional(),
  transcript: z.string().min(1).max(6000),
  cleanedTranscript: z.string().max(6000).optional(),
  origin: z.enum(["voice", "typed", "external-dictation"]).optional(),
  // The Dictation footer is replayed with the turn, or a reload still loses
  // the only evidence the speech integration ever produced.
  transcriptionConfidence: z.number().nullable().optional(),
  transcriptionLatencyMs: z.number().nullable().optional(),
  transcriptionMode: z.enum(["dictation", "sync"]).nullable().optional(),
  transcriptionFellBackFrom: z.enum(["dictation", "sync"]).nullable().optional(),
  transcriptVerbatim: z.string().max(6000).nullable().optional(),
  importance: Unit.optional(),
  confusion: Unit.optional(),
  interpretationConfidence: Unit.optional(),
  evidenceIds: z.array(Id).max(8).optional(),
  requestedAction: z.enum(["store", "explain", "quiz", "compare", "review", "evaluate", "none"]).optional(),
  sourceLocator: z
    .object({
      page: z.number().optional(),
      section: z.string().max(200).optional(),
      timestampSeconds: z.number().optional(),
      selection: z.string().max(400).optional(),
    })
    .nullable()
    .optional(),
  assessment: z.enum(["correct", "partial", "incorrect"]).nullable().optional(),
  masterySignal: z.enum(["up", "down", "flat"]).nullable().optional(),
  teachbackScore: z.number().min(0).max(1).nullable().optional(),
  hint: z.string().max(400).nullable().optional(),
}).passthrough();
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;

const ChunkSchema = z.object({
  id: Id,
  sourceId: Id,
  ordinal: z.number(),
  text: z.string().max(20_000),
  locator: z.object({ page: z.number().optional(), section: z.string().max(200).optional() }).default({}),
});

/**
 * A subject the browser built and the server has never seen.
 *
 * Validated in full rather than trusted, because a subject becomes the
 * material the tutor quotes and the questions the learner is graded on. It is
 * written under the caller's own id — `ownerId` from the request is discarded,
 * not checked — so no field here can address another learner's rows.
 */
export const ReplaySubjectSchema = z.object({
  id: Id,
  code: z.string().max(80).default(""),
  title: z.string().min(1).max(300),
  subject: z.string().max(200).default(""),
  createdAt: z.string().max(40).optional(),
  origin: z.enum(["starter", "paste", "pdf", "named"]).default("paste"),
  builtBy: z.enum(["model", "reading"]).nullable().default(null),
  keyterms: z.array(z.string().max(120)).max(100).default([]),
  languageCodes: z.array(z.string().max(12)).max(8).default(["en"]),
  sources: z.array(z.object({
    id: Id,
    title: z.string().max(300),
    type: z.string().max(40),
    chunks: z.array(ChunkSchema).max(200),
  })).max(20),
  concepts: z.array(z.object({
    id: Id,
    name: z.string().max(200),
    aliases: z.array(z.string().max(120)).max(20).default([]),
    description: z.string().max(2000).default(""),
    related: z.array(Id).max(20).default([]),
  })).max(60),
  examQuestions: z.array(z.object({
    id: Id,
    conceptId: Id,
    question: z.string().max(1000),
    requiredKeywords: z.array(z.string().max(200)).max(20).default([]),
    hint: z.string().max(600).default(""),
  })).max(60).default([]),
  teachback: z.object({
    keywords: z.record(z.array(z.string().max(200)).max(20)).default({}),
    hints: z.record(z.string().max(600)).default({}),
  }).default({ keywords: {}, hints: {} }),
  explainers: z.record(z.object({
    formal: z.string().max(4000),
    jargonFree: z.string().max(4000),
    missing: z.array(z.string().max(400)).max(10).default([]),
  })).default({}),
  traps: z.array(z.object({
    id: Id,
    conceptId: Id,
    statement: z.string().max(600),
    whyWrong: z.string().max(1000),
    correct: z.string().max(1000),
  })).max(60).default([]),
});

export const SyncRequestSchema = z.object({
  events: z.array(ReplayEventSchema).max(MAX_SYNC_EVENTS).default([]),
  subjects: z.array(ReplaySubjectSchema).max(MAX_SYNC_SUBJECTS).default([]),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export type MergeCount = { applied: number; duplicate: number; rejected: number };
export type SyncReport = {
  events: MergeCount;
  subjects: MergeCount;
  /** Why anything was turned away, so a client bug is visible and not silent. */
  rejected: { id: string; why: string }[];
};

/**
 * The one sentence about where a learner's record actually lives.
 *
 * It used to say the notes stay on this device, which described the only part
 * that survived. Now the whole record does, and the true statement is about
 * the browser rather than about the notes: it comes back here, and only here.
 */
export const DEVICE_RECORD_NOTE =
  "Your record lives in this browser. VIVA hands it back every time you open the app, so your map, your plan and your subjects come back — on this device only.";

/** A timestamp from someone else's clock, made usable. */
function safeTimestamp(raw: string | undefined, now: number): string | null {
  if (!raw) return new Date(now).toISOString();
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  if (t > now) return new Date(now).toISOString();
  if (t < now - MAX_AGE_MS) return null;
  return new Date(t).toISOString();
}

/**
 * Merge one client record into this instance's store.
 *
 * Subjects go first: an event may name a subject the server has never heard
 * of, and resolving it after the subject exists is the difference between a
 * replayed session landing on its own material and landing on the starter lab.
 *
 * Nothing here throws for bad input. A rejected event is counted and named in
 * the report; the rest of the record still lands. One malformed entry in a
 * browser's mirror must not cost the learner the other 199.
 */
export async function applySync(
  store: EventStore,
  userId: string,
  request: SyncRequest
): Promise<SyncReport> {
  const now = Date.now();
  const report: SyncReport = {
    events: { applied: 0, duplicate: 0, rejected: 0 },
    subjects: { applied: 0, duplicate: 0, rejected: 0 },
    rejected: [],
  };
  const reject = (id: string, why: string, kind: "events" | "subjects") => {
    report[kind].rejected += 1;
    if (report.rejected.length < 10) report.rejected.push({ id, why });
  };

  await store.ensureUser(userId);

  for (const incoming of request.subjects) {
    try {
      const existing = await store.getSubject(userId, incoming.id);
      if (existing) {
        report.subjects.duplicate += 1;
        continue;
      }
      // Ownership is assigned here, never accepted: `demo` is forced false so a
      // replayed subject can never dress itself up as one VIVA ships.
      const subject: Subject = {
        ...incoming,
        demo: false,
        ownerId: userId,
        createdAt: safeTimestamp(incoming.createdAt, now) ?? new Date(now).toISOString(),
        priors: undefined,
        opening: undefined,
      } as Subject;
      await store.saveSubject(userId, subject);
      report.subjects.applied += 1;
    } catch (error) {
      reject(incoming.id, message(error), "subjects");
    }
  }

  // Chronological, because the fold reads the clock: `lastSeenAt` and
  // `lastSuccessfulRecallAt` come out wrong if yesterday lands after today.
  const ordered = [...request.events]
    .map((e) => ({ e, at: safeTimestamp(e.createdAt ?? e.at, now) }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  for (const { e, at } of ordered) {
    if (!at) {
      reject(e.clientEventId, "no usable timestamp", "events");
      continue;
    }
    try {
      const outcome = await store.recordLearning(userId, {
        idempotencyKey: e.clientEventId,
        createdAt: at,
        sessionId: e.sessionId ?? `replay_${userId.slice(-8)}`,
        courseId: e.courseId ?? null,
        sourceId: e.sourceId ?? null,
        transcript: e.transcript,
        cleanedTranscript: e.cleanedTranscript ?? e.transcript,
        origin: e.origin ?? "typed",
        transcriptionConfidence: e.transcriptionConfidence ?? null,
        transcriptionLatencyMs: e.transcriptionLatencyMs ?? null,
        transcriptionSessionId: null,
        transcriptionMode: e.transcriptionMode ?? null,
        transcriptionFellBackFrom: e.transcriptionFellBackFrom ?? null,
        transcriptVerbatim: e.transcriptVerbatim ?? null,
        intent: e.intent,
        conceptIds: e.conceptIds ?? (e.primaryConceptId ? [e.primaryConceptId] : []),
        primaryConceptId: e.primaryConceptId ?? null,
        importance: e.importance ?? 0.5,
        confusion: e.confusion ?? 0,
        interpretationConfidence: e.interpretationConfidence ?? 0.5,
        evidenceIds: e.evidenceIds ?? [],
        requestedAction: e.requestedAction ?? "none",
        status: "responded",
        sourceLocator: e.sourceLocator ?? null,
        assessment: e.assessment ?? null,
        teachbackScore: e.teachbackScore ?? null,
        masterySignal: e.masterySignal ?? null,
        hint: e.hint ?? null,
      });
      if (outcome.duplicate) report.events.duplicate += 1;
      else report.events.applied += 1;
    } catch (error) {
      reject(e.clientEventId, message(error), "events");
    }
  }

  return report;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 140);
}

export type LearnerSnapshot = {
  mastery: Record<string, unknown>;
  events: unknown[];
  concepts: unknown[];
  priors: Record<string, number>;
  courses: unknown[];
  productEvents: unknown[];
  activeCourseId: string;
  learner: ReturnType<typeof learnerDNA>;
  backend: string;
  durable: boolean;
  storageNote: string | null;
};

/**
 * Everything a screen needs about this learner, from one read.
 *
 * Both `GET /api/learner` and `POST /api/learner/sync` answer with this, so a
 * reconciled reply and a plain read can never disagree about the same student —
 * four sections of one page arguing with each other was its own blocker.
 */
export async function learnerSnapshot(
  store: EventStore,
  userId: string,
  courseParam: string | null
): Promise<LearnerSnapshot> {
  const course = await resolveSubject(store, userId, courseParam);
  await store.seedCourse(userId, course.id);
  const [allMastery, allEvents, concepts, courses, productEvents, durability] = await Promise.all([
    store.getMastery(userId),
    store.listEvents(userId, 20),
    store.getConcepts(userId, course.id),
    listSubjectsFor(store, userId),
    store.productEventSummary(userId, 7),
    // ponytail: with DATABASE_URL set this probes the database twice on every
    // learner read, and this is the most-polled endpoint in the app. Free in
    // every deployment that exists today (no DATABASE_URL means it is two env
    // checks); memoise dbStatus for a few seconds if a database is ever wired.
    storeDurability(),
  ]);
  const conceptIds = new Set(concepts.map((c) => c.id));
  const mastery = courseParam
    ? Object.fromEntries(Object.entries(allMastery).filter(([id]) => conceptIds.has(id)))
    : allMastery;
  const events = courseParam ? allEvents.filter((e) => e.courseId === course.id) : allEvents;
  return {
    mastery,
    events,
    concepts,
    // Always empty, kept only so an older client does not crash on a missing
    // key. A concept with no record is "Not yet", which is the truth.
    priors: {},
    courses,
    productEvents,
    activeCourseId: course.id,
    learner: learnerDNA(
      mastery,
      events.filter((e) => e.intent === "confusion").map((e) => e.id),
      events.length
    ),
    backend: store.backend,
    durable: durability.durable,
    storageNote: durability.durable ? null : DEVICE_RECORD_NOTE,
  };
}
