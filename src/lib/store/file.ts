import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_COURSE_ID, getCourse } from "@/lib/courses";
import type { Subject } from "@/lib/courses/types";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import { scoreChunks } from "@/lib/retrieval";
import { uid, type ConceptMastery, type LearningEvent, type SourceChunk } from "@/lib/types";
import type { ConceptDef, EventStore, RecordInput, RecordOutcome } from "./repo";

/**
 * File-backed EventStore for local dev (DATA_DIR, default .data).
 * - One JSON doc per user, per-user async mutex (§68), atomic tmp+rename writes.
 * - Same interface + same reducer as Postgres; lexical retrieval.
 * - Durable on disk. EPHEMERAL on serverless (per-instance filesystem) —
 *   readiness reports this honestly; production needs DATABASE_URL.
 */

type UploadedSource = { sourceId: string; title: string; courseId: string; chunks: SourceChunk[] };

type StoredProductEvent = { name: string; fields: Record<string, number | string | boolean>; at: string };

type UserDoc = {
  userId: string;
  events: LearningEvent[];
  mastery: Record<string, ConceptMastery>;
  tutor: { role: string; content: string; evidenceIds: string[]; at: string }[];
  uploads: UploadedSource[];
  /** Subjects this user built from their own notes, keyed by subject id. */
  subjects: Record<string, Subject>;
  seeds: Record<string, boolean>;
  productEvents: StoredProductEvent[];
  sessionId: string;
};

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function dataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // Vercel/serverless filesystems are read-only except /tmp (per-instance,
  // ephemeral — readiness discloses this; production needs DATABASE_URL).
  if (process.env.VERCEL) return "/tmp/.viva-data";
  return path.join(process.cwd(), ".data");
}

function userPath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir(), `${safe}.json`);
}

/**
 * The opening state of a brand-new browser: the starter's material is
 * available, and the learner's own record is empty.
 *
 * It used to arrive pre-filled — four concepts at invented mastery levels and
 * one utterance nobody had said — so a first-time visitor was told they had
 * recalled something correctly twice. A product whose whole claim is that it
 * remembers you cannot open by inventing a you. Subjects are seeded; people
 * are not.
 */
function seedDoc(userId: string): UserDoc {
  return {
    userId,
    events: [],
    mastery: {},
    tutor: [],
    uploads: [],
    subjects: {},
    seeds: { [DEFAULT_COURSE_ID]: true },
    productEvents: [],
    sessionId: `sess_${userId}`,
  };
}

/**
 * Why this concept is due, in the student's words. Counts are only mentioned
 * when there is something to count, and they are pluralised — "1 confusions"
 * on the first screen of the morning is not a rounding error, it is the app
 * talking to itself out loud.
 */
function reviewReason(m: ConceptMastery): string {
  const parts: string[] = [];
  if (m.confusionCount > 0) parts.push(`${m.confusionCount} confusion${m.confusionCount === 1 ? "" : "s"}`);
  if (m.misconceptionCount > 0) {
    parts.push(m.misconceptionCount === 1 ? "1 time you got it mixed up" : `${m.misconceptionCount} times you got it mixed up`);
  }
  return parts.length > 0 ? parts.join(" and ") : "Due for review";
}

export class FileEventStore implements EventStore {
  readonly backend = "file" as const;

  private async load(userId: string): Promise<UserDoc> {
    try {
      const raw = await fs.readFile(userPath(userId), "utf-8");
      const doc = JSON.parse(raw) as UserDoc;
      if (!Array.isArray(doc.tutor)) doc.tutor = [];
      if (!Array.isArray(doc.uploads)) doc.uploads = [];
      if (!Array.isArray(doc.productEvents)) doc.productEvents = [];
      if (!doc.subjects || typeof doc.subjects !== "object") doc.subjects = {};
      if (!doc.seeds || typeof doc.seeds !== "object") doc.seeds = {};
      // Legacy docs were seeded with the default lab only.
      doc.seeds[DEFAULT_COURSE_ID] = true;
      for (const u of doc.uploads) if (!u.courseId) u.courseId = DEFAULT_COURSE_ID;
      return doc;
    } catch {
      const doc = seedDoc(userId);
      await this.save(doc);
      return doc;
    }
  }

  private async save(doc: UserDoc): Promise<void> {
    await fs.mkdir(dataDir(), { recursive: true });
    const tmp = `${userPath(doc.userId)}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(doc), "utf-8");
    await fs.rename(tmp, userPath(doc.userId));
  }

  async ensureUser(): Promise<void> { /* file store is implicit per userId */ }

  async seedDemoCourse(userId: string): Promise<void> {
    await this.seedCourse(userId, DEFAULT_COURSE_ID);
  }

  async seedCourse(userId: string, courseId: string): Promise<void> {
    await withLock(userId, async () => {
      const doc = await this.load(userId);
      if (doc.seeds[courseId]) return;
      doc.seeds[courseId] = true;
      await this.save(doc);
    });
  }

  async recordLearning(userId: string, input: RecordInput): Promise<RecordOutcome> {
    return withLock(userId, async () => {
      const doc = await this.load(userId);
      const dupe = doc.events.find((e) => (e as unknown as { idempotencyKey?: string }).idempotencyKey === input.idempotencyKey);
      if (dupe) {
        return { event: dupe, mastery: doc.mastery, delta: null, reason: "duplicate suppressed", duplicate: true };
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      let delta: number | null = null;
      let reason: string | null = null;
      if (input.primaryConceptId) {
        const prev = doc.mastery[input.primaryConceptId] ?? blankMastery(input.primaryConceptId, createdAt);
        const r = reduceMastery(prev, {
          intent: input.intent, createdAt,
          assessment: input.assessment ?? null, teachbackScore: input.teachbackScore ?? null,
          masterySignal: input.masterySignal ?? null,
        });
        doc.mastery[input.primaryConceptId] = r.next;
        delta = r.delta; reason = r.reason;
      }
      const event: LearningEvent & { idempotencyKey: string } = {
        id: uid("evt"), userId, sessionId: input.sessionId,
        courseId: input.courseId, sourceId: input.sourceId, createdAt,
        transcript: input.transcript, cleanedTranscript: input.cleanedTranscript, origin: input.origin,
        transcriptionConfidence: input.transcriptionConfidence, transcriptionLatencyMs: input.transcriptionLatencyMs,
        transcriptionMode: input.transcriptionMode ?? null,
        transcriptionFellBackFrom: input.transcriptionFellBackFrom ?? null,
        transcriptVerbatim: input.transcriptVerbatim ?? null,
        intent: input.intent, conceptIds: input.conceptIds, primaryConceptId: input.primaryConceptId,
        importance: input.importance, confusion: input.confusion, confidenceSelfReport: null,
        sourceLocator: input.sourceLocator, interpretationConfidence: input.interpretationConfidence,
        evidenceIds: input.evidenceIds, requestedAction: input.requestedAction, status: input.status,
        assessment: input.assessment ?? null, delta, reason, hint: input.hint ?? null,
        masterySignal: input.masterySignal ?? null,
        idempotencyKey: input.idempotencyKey,
      };
      doc.events.push(event);
      // A replay can carry an event older than one already stored, and
      // `listEvents` hands out the tail — so the tail has to be the newest
      // events, not the most recently written ones.
      doc.events.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      await this.save(doc);
      return { event, mastery: doc.mastery, delta, reason, duplicate: false };
    });
  }

  async listEvents(userId: string, limit = 50): Promise<LearningEvent[]> {
    const doc = await this.load(userId);
    return doc.events.slice(-limit);
  }

  async getMastery(userId: string): Promise<Record<string, ConceptMastery>> {
    return (await this.load(userId)).mastery;
  }

  async saveSubject(userId: string, subject: Subject): Promise<void> {
    await withLock(userId, async () => {
      const doc = await this.load(userId);
      doc.subjects[subject.id] = subject;
      doc.seeds[subject.id] = true;
      // No mastery rows: a concept the learner has not touched is "Not yet",
      // and writing a row at the default 0.5 makes the map claim otherwise.
      await this.save(doc);
    });
  }

  async getSubject(userId: string, subjectId: string): Promise<Subject | null> {
    return (await this.load(userId)).subjects[subjectId] ?? null;
  }

  async listSubjects(userId: string): Promise<Subject[]> {
    return Object.values((await this.load(userId)).subjects);
  }

  async getCourseChunks(userId: string, courseId: string = DEFAULT_COURSE_ID): Promise<SourceChunk[]> {
    const doc = await this.load(userId);
    const own = doc.subjects[courseId];
    const seeded = (own ?? getCourse(courseId)).sources.flatMap((s) => s.chunks);
    return [...seeded, ...doc.uploads.filter((u) => u.courseId === courseId).flatMap((u) => u.chunks)];
  }

  async getConcepts(userId: string, courseId: string = DEFAULT_COURSE_ID): Promise<ConceptDef[]> {
    const own = (await this.load(userId)).subjects[courseId];
    return (own ?? getCourse(courseId)).concepts.map((c) => ({ id: c.id, name: c.name, description: c.description, aliases: c.aliases, related: c.related }));
  }

  async retrieveEvidence(userId: string, query: string, opts: { sourceId?: string | null; conceptIds?: string[]; limit?: number; courseId?: string } = {}) {
    const chunks = await this.getCourseChunks(userId, opts.courseId ?? DEFAULT_COURSE_ID);
    const pool = opts.sourceId ? chunks.filter((c) => c.sourceId === opts.sourceId) : chunks;
    const { courseId: _courseId, ...rest } = opts;
    return scoreChunks(pool.length ? pool : chunks, query, { ...rest, sourceId: null });
  }

  async addSource(userId: string, input: { title: string; type: string; chunks: { text: string; section: string; page?: number }[]; courseId?: string }) {
    return withLock(userId, async () => {
      const doc = await this.load(userId);
      const courseId = input.courseId ?? DEFAULT_COURSE_ID;
      const sourceId = `src_up_${Date.now().toString(36)}`;
      const chunks = input.chunks.map((c, i) => ({
        id: `ch_up_${Date.now().toString(36)}_${i}`,
        sourceId,
        ordinal: 1000 + i,
        text: c.text,
        locator: { section: c.section, page: c.page },
      }));
      doc.uploads.push({ sourceId, title: input.title, courseId, chunks });
      await this.save(doc);
      return { sourceId, chunkIds: chunks.map((c) => c.id) };
    });
  }

  async getReviewQueue(userId: string) {
    const mastery = await this.getMastery(userId);
    return Object.values(mastery)
      .filter((m) => m.reviewPriority >= 0.55)
      .sort((a, b) => b.reviewPriority - a.reviewPriority)
      .slice(0, 10)
      .map((m) => ({
        conceptId: m.conceptId,
        dueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        priority: m.reviewPriority,
        reason: reviewReason(m),
      }));
  }

  async enqueueReview(): Promise<void> { /* review due-dates derive from mastery in file mode */ }

  async saveTutorMessage(userId: string, _sessionId: string, role: "user" | "assistant", content: string, evidenceIds: string[]): Promise<void> {
    await withLock(userId, async () => {
      const doc = await this.load(userId);
      doc.tutor.push({ role, content: content.slice(0, 4000), evidenceIds, at: new Date().toISOString() });
      await this.save(doc);
    });
  }

  async recordProductEvent(userId: string, name: string, fields: Record<string, number | string | boolean> = {}): Promise<void> {
    await withLock(userId, async () => {
      const doc = await this.load(userId);
      doc.productEvents.push({ name, fields, at: new Date().toISOString() });
      if (doc.productEvents.length > 1000) doc.productEvents = doc.productEvents.slice(-1000);
      await this.save(doc);
    });
  }

  async productEventSummary(userId: string, days = 7): Promise<{ name: string; count: number }[]> {
    const since = Date.now() - days * 24 * 3600 * 1000;
    const counts = new Map<string, number>();
    for (const e of (await this.load(userId)).productEvents) {
      if (Date.parse(e.at) < since) continue;
      counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  async deleteUserData(userId: string): Promise<void> {
    await withLock(userId, async () => {
      try { await fs.unlink(userPath(userId)); } catch { /* already gone */ }
    });
  }
}
