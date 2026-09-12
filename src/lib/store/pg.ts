import { dbQuery } from "@/lib/db/db";
import { DEFAULT_COURSE_ID, getCourse } from "@/lib/courses";
import { blankMastery, reduceMastery } from "@/lib/mastery";
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
    origin: (r.origin as "voice" | "typed") ?? "voice",
    transcriptionConfidence: (r.transcription_confidence as number) ?? null,
    transcriptionLatencyMs: (r.transcription_latency_ms as number) ?? null,
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

export class PgEventStore implements EventStore {
  readonly backend = "postgres" as const;

  async ensureUser(userId: string, displayName?: string): Promise<void> {
    await dbQuery("INSERT INTO users(id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [userId, displayName ?? null]);
  }

  async seedDemoCourse(userId: string): Promise<void> {
    await this.seedCourse(userId, DEFAULT_COURSE_ID);
  }

  async seedCourse(userId: string, courseId: string): Promise<void> {
    const course = getCourse(courseId);
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
    // Realistic priors for the golden demo (labeled demo data, §11). Only the
    // default lab carries them; other labs start from blank mastery.
    if (course.id !== DEFAULT_COURSE_ID) return;
    const now = new Date().toISOString();
    const priors: Record<string, Partial<ConceptMastery>> = {
      [scopeId("c_self_attention", userId, course.id)]: { exposureCount: 4, successfulRecallCount: 2, mastery: 0.68, confidence: 0.55, reviewPriority: 0.35, lastSuccessfulRecallAt: now },
      [scopeId("c_qkv", userId, course.id)]: { exposureCount: 3, successfulRecallCount: 1, confusionCount: 1, mastery: 0.58, confidence: 0.5, reviewPriority: 0.45, lastSuccessfulRecallAt: now },
      [scopeId("c_position", userId, course.id)]: { exposureCount: 2, confusionCount: 1, mastery: 0.44, confidence: 0.4, reviewPriority: 0.62 },
      [scopeId("c_multihead", userId, course.id)]: { exposureCount: 1, mastery: 0.5, confidence: 0.35, reviewPriority: 0.5 },
    };
    for (const [cid, p] of Object.entries(priors)) {
      const base = blankMastery(stripScope(cid), now);
      await dbQuery(
        `INSERT INTO mastery_state(user_id, concept_id, exposure_count, successful_recall_count, failed_recall_count,
          confusion_count, misconception_count, last_seen_at, last_successful_recall_at, mastery, confidence, review_priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (user_id, concept_id) DO NOTHING`,
        [userId, cid, p.exposureCount ?? base.exposureCount, p.successfulRecallCount ?? 0, p.failedRecallCount ?? 0,
         p.confusionCount ?? 0, p.misconceptionCount ?? 0, now, p.lastSuccessfulRecallAt ?? null,
         p.mastery ?? 0.5, p.confidence ?? 0.3, p.reviewPriority ?? 0.5]
      );
    }
    // Seed remember event so history is non-empty.
    const seedSource = course.sources[0];
    await dbQuery(
      `INSERT INTO learning_events(id, user_id, session_id, course_id, source_id, idempotency_key, transcript,
        cleaned_transcript, origin, transcription_confidence, intent, concept_ids, primary_concept_id,
        importance, confusion, interpretation_confidence, evidence_ids, requested_action, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'voice',0.97,'remember',$9,$10,0.7,0.1,0.85,$11,'store','grounded')
       ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      [`evt_seed_001::${userId}`, userId, `sess_demo::${userId}`, scopedCourse, seedSource ? scopeId(seedSource.id, userId, course.id) : null, "seed-001",
       "Multi-head attention runs several attention computations in parallel.",
       "Multi-head attention runs several attention computations in parallel.",
       JSON.stringify([scopeId("c_multihead", userId, course.id)]), scopeId("c_multihead", userId, course.id),
       JSON.stringify([scopeId("ch_mh_1", userId, course.id)])]
    );
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
          assessment, hint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
        [uid("evt"), userId, input.sessionId, courseId, sourceId, input.idempotencyKey,
         input.transcript, input.cleanedTranscript, input.origin, input.transcriptionConfidence,
         input.transcriptionLatencyMs, input.transcriptionSessionId, input.intent,
         JSON.stringify(conceptIds), cid, input.importance, input.confusion,
         input.interpretationConfidence, JSON.stringify(evidenceIds), input.requestedAction,
         input.status, JSON.stringify(input.sourceLocator), input.assessment ?? null, input.hint ?? null]
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
        const prev = row.rows.length ? toMastery(row.rows[0]) : blankMastery(stripScope(cid as string), new Date().toISOString());
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
    return rows.map((r) => ({
      id: stripScope(r.id as string), sourceId: stripScope(r.source_id as string), ordinal: r.ordinal as number,
      text: r.text as string, locator: (r.locator ?? {}) as SourceChunk["locator"],
    }));
  }

  async getConcepts(userId: string, courseId: string = DEFAULT_COURSE_ID): Promise<ConceptDef[]> {
    const rows = await dbQuery<Record<string, unknown>>(
      "SELECT * FROM concepts WHERE user_id=$1 AND course_id=$2", [userId, scopeId(courseId, userId, courseId)]
    );
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
    const limit = opts.limit ?? 3;
    const courseId = opts.courseId ?? DEFAULT_COURSE_ID;
    const scopedSource = opts.sourceId
      ? (opts.sourceId.includes("::") ? opts.sourceId : scopeId(opts.sourceId, userId, courseId))
      : null;
    const rows = await dbQuery<{ id: string; source_id: string; ordinal: number; text: string; locator: unknown; score: number }>(
      `SELECT c.id, c.source_id, c.ordinal, c.text, c.locator,
              ts_rank(c.search, plainto_tsquery('english', $2)) AS score
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
       WHERE c.user_id=$1 AND s.course_id=$3 AND ($4::text IS NULL OR c.source_id LIKE $4 || '%')
         AND c.search @@ plainto_tsquery('english', $2)
       ORDER BY score DESC LIMIT $5`,
      [userId, query, scopeId(courseId, userId, courseId), scopedSource, limit]
    );
    if (!rows.length) return [];
    return rows.map((r) => ({
      chunk: {
        id: stripScope(r.id), sourceId: stripScope(r.source_id), ordinal: r.ordinal, text: r.text,
        locator: (r.locator ?? {}) as SourceChunk["locator"],
      },
      score: Number(r.score),
    }));
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
