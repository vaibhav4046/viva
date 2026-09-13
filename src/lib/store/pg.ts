import { dbQuery } from "@/lib/db/db";
import { COURSES, DEFAULT_COURSE_ID, getCourse } from "@/lib/courses";
import type { Course, Subject } from "@/lib/courses/types";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import { scoreChunks } from "@/lib/retrieval";
import { uid, type ConceptMastery, type LearningEvent, type SourceChunk } from "@/lib/types";
import type { ConceptDef, EventStore, RecordInput, RecordOutcome } from "./repo";

/**
 * Postgres EventStore. Concurrency: recordLearning runs in ONE transaction
 * with SELECT ... FOR UPDATE on the mastery row — two simultaneous events
 * for the same concept serialize instead of corrupting state (§68).
 * Retrieval: tsvector rank + active-source filter (§18); lexical lives on
 * in the file store and as a query fallback.
 */

function toEvent(r: Record<string, unknown>): LearningEvent {
  const strArr = (v: unknown): string[] => ((v as string[]) ?? []).map(stripScope);
  return {
    id: r.id as string,
    userId: r.user_id as string,
    sessionId: stripScope(r.session_id as string),
    courseId: r.course_id ? stripScope(r.course_id as string) : null,
    sourceId: r.source_id ? stripScope(r.source_id as string) : null,
    createdAt: (r.created_at as Date).toISOString(),
    transcript: r.transcript as string,
    cleanedTranscript: r.cleaned_transcript as string,
    origin: (r.origin as LearningEvent["origin"]) ?? "voice",
    transcriptionConfidence: (r.transcription_confidence as number) ?? null,
    transcriptionLatencyMs: (r.transcription_latency_ms as number) ?? null,
    transcriptionMode: (r.transcription_mode as LearningEvent["transcriptionMode"]) ?? null,
    transcriptionFellBackFrom: (r.transcription_fell_back_from as LearningEvent["transcriptionFellBackFrom"]) ?? null,
    transcriptVerbatim: (r.transcript_verbatim as string | null) ?? null,
    intent: r.intent as LearningEvent["intent"],
    conceptIds: strArr(r.concept_ids),
    primaryConceptId: r.primary_concept_id ? stripScope(r.primary_concept_id as string) : null,
    importance: Number(r.importance ?? 0.5),
    confusion: Number(r.confusion ?? 0),
    confidenceSelfReport: null,
    sourceLocator: (r.source_locator as LearningEvent["sourceLocator"]) ?? null,
    interpretationConfidence: Number(r.interpretation_confidence ?? 0.5),
    evidenceIds: strArr(r.evidence_ids),
    requestedAction: (r.requested_action as LearningEvent["requestedAction"]) ?? "none",
    status: (r.status as LearningEvent["status"]) ?? "captured",
    assessment: (r.assessment as LearningEvent["assessment"]) ?? null,
    delta: r.delta === null || r.delta === undefined ? null : Number(r.delta),
    reason: (r.reason as string | null) ?? null,
    hint: (r.hint as string | null) ?? null,
    masterySignal: (r.mastery_signal as LearningEvent["masterySignal"]) ?? null,
  };
}

function toMastery(r: Record<string, unknown>): ConceptMastery {
  return {
    conceptId: r.concept_id as string,
    exposureCount: Number(r.exposure_count ?? 0),
    successfulRecallCount: Number(r.successful_recall_count ?? 0),
    failedRecallCount: Number(r.failed_recall_count ?? 0),
    confusionCount: Number(r.confusion_count ?? 0),
    misconceptionCount: Number(r.misconception_count ?? 0),
    teachbackScoreAvg: (r.teachback_score_avg as number) ?? null,
    lastSeenAt: (r.last_seen_at as Date).toISOString(),
    lastSuccessfulRecallAt: r.last_successful_recall_at ? (r.last_successful_recall_at as Date).toISOString() : null,
    mastery: Number(r.mastery ?? 0.5),
    confidence: Number(r.confidence ?? 0.3),
    reviewPriority: Number(r.review_priority ?? 0.5),
  };
}

/**
 * Passages of a subject that ships with the app, which no database holds.
 *
 * `COURSES[id]`, never `getCourse(id)`: getCourse resolves an unknown id to the
 * default Transformers lab, which is right for a picker and catastrophic here.
 * A learner's own subject id is never in COURSES, so routing it through
 * getCourse answered a pasted subject on the heart with the reinforcement-
 * learning passages of a lab they had never opened — three runs out of three,
 * and only with a database attached. That is precisely the guarantee the
 * product is built on: a citation resolves to a passage of *this* subject or
 * there is no citation. An unknown id has no compiled passages, full stop.
 */
function compiledChunks(courseId: string): SourceChunk[] {
  return COURSES[courseId]?.sources.flatMap((src) => src.chunks) ?? [];
}

export class PgEventStore implements EventStore {
  readonly backend = "postgres" as const;

  async ensureUser(userId: string, displayName?: string): Promise<void> {
    await dbQuery("INSERT INTO users(id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [userId, displayName ?? null]);
  }

  async seedDemoCourse(userId: string): Promise<void> {
    await this.seedCourse(userId, DEFAULT_COURSE_ID);
  }

  /**
   * Seed a starter. An id we do not ship belongs to a subject the learner
   * built: `saveSubject` already wrote its rows, so there is nothing to seed
   * here — and falling back to the default would seed the wrong subject.
   */
  async seedCourse(userId: string, courseId: string): Promise<void> {
    const course = COURSES[courseId];
    if (!course) return;
    await this.seedCourseRows(userId, course);
  }

  /** Rows for one course or subject: course, sources, chunks, concepts, edges. */
  private async seedCourseRows(userId: string, course: Course | Subject): Promise<void> {
    await this.ensureUser(userId, "Demo learner");
    const scopedCourse = scopeId(course.id, userId, course.id);
    await dbQuery(
      "INSERT INTO courses(id, user_id, title, subject, level, is_demo) VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT (id) DO NOTHING",
      [scopedCourse, userId, course.title, course.subject, "MSc"]
    );
    for (const src of course.sources) {
      const sourceId = scopeId(src.id, userId, course.id);
      await dbQuery(
        "INSERT INTO sources(id, course_id, user_id, type, title) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
        [sourceId, scopedCourse, userId, src.type, src.title]
      );
      for (const c of src.chunks) {
        await dbQuery(
          "INSERT INTO source_chunks(id, source_id, user_id, ordinal, text, locator) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
          [scopeId(c.id, userId, course.id), sourceId, userId, c.ordinal, c.text, JSON.stringify(c.locator)]
        );
      }
    }
    for (const c of course.concepts) {
      await dbQuery(
        "INSERT INTO concepts(id, course_id, user_id, canonical_name, description, aliases) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
        [scopeId(c.id, userId, course.id), scopedCourse, userId, c.name, c.description, JSON.stringify(c.aliases)]
      );
    }
    for (const c of course.concepts) {
      for (const rel of c.related) {
        await dbQuery(
          "INSERT INTO concept_edges(id, user_id, source_concept_id, target_concept_id) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
          [scopeId(`edge_${c.id}_${rel}`, userId, course.id), userId, scopeId(c.id, userId, course.id), scopeId(rel, userId, course.id)]
        );
      }
    }
  }

  /**
   * Persist a subject the learner built. The document holds the parts only
   * this subject knows (questions, explainers, keyterms); its passages and
   * concepts also land in the normal tables, so retrieval, the map and the
   * mastery fold need no second code path.
   */
  async saveSubject(userId: string, subject: Subject): Promise<void> {
    await this.ensureUser(userId);
    await dbQuery(
      `INSERT INTO subjects(id, user_id, doc) VALUES ($1,$2,$3)
       ON CONFLICT (id, user_id) DO UPDATE SET doc = EXCLUDED.doc`,
      [subject.id, userId, JSON.stringify(subject)]
    );
    await this.seedCourseRows(userId, subject);
    // No mastery rows: a concept the learner has not touched is "Not yet",
    // and writing a row at the default 0.5 makes the map claim otherwise.
  }

  async getSubject(userId: string, subjectId: string): Promise<Subject | null> {
    const rows = await dbQuery<{ doc: Subject }>(
      "SELECT doc FROM subjects WHERE user_id=$1 AND id=$2", [userId, subjectId]
    );
    return rows[0]?.doc ?? null;
  }

  async listSubjects(userId: string): Promise<Subject[]> {
    const rows = await dbQuery<{ doc: Subject }>(
      "SELECT doc FROM subjects WHERE user_id=$1 ORDER BY created_at DESC", [userId]
    );
    return rows.map((r) => r.doc);
  }

  async recordLearning(userId: string, input: RecordInput): Promise<RecordOutcome> {
    const { getPool } = await import("@/lib/db/db");
    // Namespace per-user, per-course concept/evidence ids so global compiler
    // output maps to owned rows (§15). Reads strip the suffixes back off.
    const courseBase = input.courseId ? stripScope(input.courseId) : DEFAULT_COURSE_ID;
    const ns = (id: string | null): string | null => (!id ? null : id.includes("::") ? id : scopeId(id, userId, courseBase));
    const cid = ns(input.primaryConceptId);
    const conceptIds = input.conceptIds.map((c) => ns(c) as string);
    const evidenceIds = input.evidenceIds.map((e) => ns(e) as string);
    const courseId = input.courseId && !input.courseId.includes("::") && input.courseId.startsWith("course_") ? scopeId(input.courseId, userId, courseBase) : input.courseId;
    const sourceId = input.sourceId && !input.sourceId.includes("::") && input.sourceId.startsWith("src_") ? scopeId(input.sourceId, userId, courseBase) : input.sourceId;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
      const ins = await client.query(
        // assessment/hint land on the INSERT; delta/reason are known only after
        // the mastery fold below and are written by the UPDATE that follows.
        `INSERT INTO learning_events(id, user_id, session_id, course_id, source_id, idempotency_key,
          transcript, cleaned_transcript, origin, transcription_confidence, transcription_latency_ms,
          transcription_session_id, intent, concept_ids, primary_concept_id, importance, confusion,
          interpretation_confidence, evidence_ids, requested_action, status, source_locator,
          assessment, hint, mastery_signal, transcription_mode, transcription_fell_back_from,
          transcript_verbatim, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
                 $26,$27,$28,COALESCE($29::timestamptz, now()))
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
        [uid("evt"), userId, input.sessionId, courseId, sourceId, input.idempotencyKey,
         input.transcript, input.cleanedTranscript, input.origin, input.transcriptionConfidence,
         input.transcriptionLatencyMs, input.transcriptionSessionId, input.intent,
         JSON.stringify(conceptIds), cid, input.importance, input.confusion,
         input.interpretationConfidence, JSON.stringify(evidenceIds), input.requestedAction,
         input.status, JSON.stringify(input.sourceLocator), input.assessment ?? null, input.hint ?? null,
         input.masterySignal ?? null, input.transcriptionMode ?? null,
         input.transcriptionFellBackFrom ?? null, input.transcriptVerbatim ?? null,
         input.createdAt ?? null]
      );
      if (ins.rows.length === 0) {
        // Duplicate retry (§23): return the original, never a second Thought Mark.
        const existing = await client.query("SELECT * FROM learning_events WHERE user_id=$1 AND idempotency_key=$2", [userId, input.idempotencyKey]);
        const mastery = await this.readMastery(client, userId);
        await client.query("COMMIT");
        return { event: toEvent(existing.rows[0]), mastery, delta: null, reason: "duplicate suppressed", duplicate: true };
      }
      const event = toEvent(ins.rows[0]);
      let delta: number | null = null;
      let reason: string | null = null;
      if (cid) {
        const row = await client.query("SELECT * FROM mastery_state WHERE user_id=$1 AND concept_id=$2 FOR UPDATE", [userId, cid]);
        const prev = row.rows.length ? toMastery(row.rows[0]) : blankMastery(stripScope(cid as string), event.createdAt);
        const { next, delta: d, reason: r } = reduceMastery(prev, {
          intent: input.intent, createdAt: event.createdAt, assessment: input.assessment ?? null, teachbackScore: input.teachbackScore ?? null,
          masterySignal: input.masterySignal ?? null,
        });
        delta = d; reason = r;
        await client.query(
          `INSERT INTO mastery_state(user_id, concept_id, exposure_count, successful_recall_count, failed_recall_count,
            confusion_count, misconception_count, teachback_score_avg, last_seen_at, last_successful_recall_at,
            mastery, confidence, review_priority, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)
           ON CONFLICT (user_id, concept_id) DO UPDATE SET
             exposure_count=EXCLUDED.exposure_count, successful_recall_count=EXCLUDED.successful_recall_count,
             failed_recall_count=EXCLUDED.failed_recall_count, confusion_count=EXCLUDED.confusion_count,
             misconception_count=EXCLUDED.misconception_count, teachback_score_avg=EXCLUDED.teachback_score_avg,
             last_seen_at=EXCLUDED.last_seen_at, last_successful_recall_at=EXCLUDED.last_successful_recall_at,
             mastery=EXCLUDED.mastery, confidence=EXCLUDED.confidence, review_priority=EXCLUDED.review_priority,
             version=mastery_state.version+1`,
           [userId, cid, next.exposureCount, next.successfulRecallCount, next.failedRecallCount,
            next.confusionCount, next.misconceptionCount, next.teachbackScoreAvg, next.lastSeenAt,
            next.lastSuccessfulRecallAt, next.mastery, next.confidence, next.reviewPriority]
        );
        await client.query(
          "UPDATE learning_events SET delta=$1, reason=$2 WHERE id=$3 AND user_id=$4",
          [delta, reason, event.id, userId]
        );
      }
      const mastery = await this.readMastery(client, userId);
      await client.query("COMMIT");
      return { event, mastery, delta, reason, duplicate: false };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async readMastery(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, userId: string): Promise<Record<string, ConceptMastery>> {
    const rows = (await client.query("SELECT * FROM mastery_state WHERE user_id=$1", [userId])).rows;
    const out: Record<string, ConceptMastery> = {};
    for (const r of rows) out[stripScope(r.concept_id as string)] = toMastery(r);
    return out;
  }

  async listEvents(userId: string, limit = 50): Promise<LearningEvent[]> {
    const rows = await dbQuery<Record<string, unknown>>(
      "SELECT * FROM learning_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, limit]
    );
    return rows.map(toEvent).reverse();
  }

  async getMastery(userId: string): Promise<Record<string, ConceptMastery>> {
    const rows = await dbQuery<Record<string, unknown>>("SELECT * FROM mastery_state WHERE user_id=$1", [userId]);
    const out: Record<string, ConceptMastery> = {};
    for (const r of rows) out[stripScope(r.concept_id as string)] = toMastery(r);
    return out;
  }

  async getCourseChunks(userId: string, courseId: string = DEFAULT_COURSE_ID): Promise<SourceChunk[]> {
    const rows = await dbQuery<Record<string, unknown>>(
      `SELECT c.* FROM source_chunks c JOIN sources s ON s.id=c.source_id
       WHERE c.user_id=$1 AND s.course_id=$2 ORDER BY c.ordinal`, [userId, scopeId(courseId, userId, courseId)]
    );
    if (rows.length) {
      return rows.map((r) => ({
        id: stripScope(r.id as string), sourceId: stripScope(r.source_id as string), ordinal: r.ordinal as number,
        text: r.text as string, locator: (r.locator ?? {}) as SourceChunk["locator"],
      }));
    }
    // The subjects VIVA ships live in code, not in this database, and nothing
    // ever inserts them — so on Postgres every shipped subject had no passages
    // at all and the tutor answered "that is not in this subject" to every
    // claim, including the ones that always worked. The file store has always
    // fallen back to the compiled registry here; this path simply never ran
    // with a real database behind it. A learner's own subject is in the rows
    // above and still wins.
    return compiledChunks(courseId);
  }

  async getConcepts(userId: string, courseId: string = DEFAULT_COURSE_ID): Promise<ConceptDef[]> {
    const rows = await dbQuery<Record<string, unknown>>(
      "SELECT * FROM concepts WHERE user_id=$1 AND course_id=$2", [userId, scopeId(courseId, userId, courseId)]
    );
    // Same reason as getCourseChunks: a shipped subject's concepts are compiled
    // in, so without this the map is empty on Postgres.
    // Same rule as compiledChunks: an unknown id borrows nobody's concepts.
    const compiled = COURSES[courseId];
    if (!rows.length && compiled) {
      return compiled.concepts.map((c) => ({
        id: c.id, name: c.name, description: c.description, aliases: c.aliases, related: c.related,
      }));
    }
    const edges = await dbQuery<Record<string, unknown>>(
      "SELECT source_concept_id, target_concept_id FROM concept_edges WHERE user_id=$1", [userId]
    );
    const rel = new Map<string, string[]>();
    for (const e of edges) {
      const s = stripScope(e.source_concept_id as string);
      const t = stripScope(e.target_concept_id as string);
      if (!rel.has(s)) rel.set(s, []);
      rel.get(s)?.push(t);
    }
    return rows.map((r) => {
      const id = stripScope(r.id as string);
      return {
        id, name: r.canonical_name as string,
        description: (r.description as string) ?? "", aliases: (r.aliases as string[]) ?? [],
        related: rel.get(id) ?? [],
      };
    });
  }

  async retrieveEvidence(userId: string, query: string, opts: { sourceId?: string | null; conceptIds?: string[]; limit?: number; courseId?: string } = {}): Promise<{ chunk: SourceChunk; score: number }[]> {
    /*
     * One retrieval implementation for both stores, deliberately.
     *
     * This used to rank in SQL with `search @@ plainto_tsquery(...)`, and
     * plainto_tsquery ANDs every term — so "Explain how the heart valves stop
     * backflow" demanded that "explain" and "stop" appear in the passage and
     * matched nothing. A learner's own subject was unreachable on Postgres
     * while the identical subject answered fine on the file store, because the
     * two stores were running different retrieval semantics and only one of
     * them had ever been exercised.
     *
     * Postgres full-text ranking may well beat `scoreChunks` one day, but two
     * implementations that disagree is worse than one that is merely adequate:
     * every tutor guarantee is stated in terms of the passages retrieval
     * returns, so retrieval differing by storage backend makes those
     * guarantees untestable. A subject caps at 120 passages, so scoring in
     * memory is bounded.
     */
    const chunks = await this.getCourseChunks(userId, opts.courseId ?? DEFAULT_COURSE_ID);
    if (!chunks.length) return [];
    const pool = opts.sourceId ? chunks.filter((c) => c.sourceId === opts.sourceId) : chunks;
    const { courseId: _courseId, ...rest } = opts;
    return scoreChunks(pool.length ? pool : chunks, query, { ...rest, sourceId: null });
  }

  async enqueueReview(userId: string, conceptId: string, priority: number, reason: string): Promise<void> {
    const due = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await dbQuery(
      `INSERT INTO review_queue(user_id, concept_id, due_at, priority, reason) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, concept_id) DO UPDATE SET priority=GREATEST(review_queue.priority, EXCLUDED.priority), reason=EXCLUDED.reason`,
      [userId, conceptId, due, priority, reason]
    );
  }

  async saveTutorMessage(userId: string, sessionId: string, role: "user" | "assistant", content: string, evidenceIds: string[]): Promise<void> {
    await dbQuery(
      "INSERT INTO tutor_messages(id, user_id, session_id, role, content, evidence_ids) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid("msg"), userId, sessionId, role, content.slice(0, 4000), JSON.stringify(evidenceIds)]
    );
  }

  async getReviewQueue(userId: string): Promise<{ conceptId: string; dueAt: string; priority: number; reason: string }[]> {
    const rows = await dbQuery<Record<string, unknown>>(
      "SELECT concept_id, due_at, priority, reason FROM review_queue WHERE user_id=$1 ORDER BY priority DESC", [userId]
    );
    return rows.map((r) => ({
      conceptId: stripScope(r.concept_id as string), dueAt: (r.due_at as Date).toISOString(),
      priority: Number(r.priority), reason: r.reason as string,
    }));
  }

  async addSource(userId: string, input: { title: string; type: string; chunks: { text: string; section: string; page?: number }[]; courseId?: string }): Promise<{ sourceId: string; chunkIds: string[] }> {
    await this.ensureUser(userId);
    const courseId = input.courseId ?? DEFAULT_COURSE_ID;
    await this.seedCourse(userId, courseId);
    const scopedCourse = scopeId(courseId, userId, courseId);
    const sourceBase = `src_up_${Date.now().toString(36)}`;
    const sourceId = scopeId(sourceBase, userId, courseId);
    await dbQuery("INSERT INTO sources(id, course_id, user_id, type, title) VALUES ($1,$2,$3,$4,$5)",
      [sourceId, scopedCourse, userId, input.type, input.title]);
    const chunkIds: string[] = [];
    let ord = 1000;
    for (const c of input.chunks) {
      const cidBase = `ch_up_${Date.now().toString(36)}_${ord}`;
      await dbQuery(
        "INSERT INTO source_chunks(id, source_id, user_id, ordinal, text, locator) VALUES ($1,$2,$3,$4,$5,$6)",
        [scopeId(cidBase, userId, courseId), sourceId, userId, ord++, c.text, JSON.stringify({ section: c.section, page: c.page })]
      );
      chunkIds.push(cidBase);
    }
    return { sourceId: sourceBase, chunkIds };
  }

  async deleteUserData(userId: string): Promise<void> {
    // product_events has no FK cascade; clear instrumentation first (best effort).
    await dbQuery("DELETE FROM product_events WHERE user_id=$1", [userId]).catch(() => {});
    await dbQuery("DELETE FROM users WHERE id=$1", [userId]);
  }

  async recordProductEvent(userId: string, name: string, fields: Record<string, number | string | boolean> = {}): Promise<void> {
    // product_events ships in migration 001; guarded so an older deployment
    // never breaks a page view over instrumentation.
    try {
      await dbQuery(
        "INSERT INTO product_events(id, user_id, name, fields) VALUES ($1,$2,$3,$4)",
        [uid("pe"), userId, name, JSON.stringify(fields)]
      );
    } catch { /* instrumentation is best-effort by design */ }
  }

  async productEventSummary(userId: string, days = 7): Promise<{ name: string; count: number }[]> {
    try {
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const rows = await dbQuery<{ name: string; count: string | number }>(
        "SELECT name, COUNT(*) AS count FROM product_events WHERE user_id=$1 AND created_at >= $2 GROUP BY name ORDER BY count DESC, name ASC",
        [userId, since]
      );
      return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
    } catch {
      return [];
    }
  }
}

/** Per-user, per-course row ids: `${base}::${userId}::${courseId}`. */
function scopeId(base: string, userId: string, courseId: string): string {
  return `${base}::${userId}::${courseId}`;
}

function stripScope(id: string): string {
  const i = id.indexOf("::");
  return i > 0 ? id.slice(0, i) : id;
}
