"use client";
import type { Subject } from "@/lib/courses/types";
import type { ConceptMastery, LearningEvent, SourceChunk } from "@/lib/types";

/**
 * The browser's copy of the learner record.
 *
 * Measured on the deployment: ten parallel reads of one student's record on one
 * cookie, four came back empty. Every write goes to one lambda's own `/tmp`, so
 * two page loads are two different memories of the same person — the map drops
 * a band while the student is reading it, the plan is empty on the screen whose
 * whole job is a plan, and a subject built ninety seconds ago is not in the
 * list. "Your notes" survived all of that, because it was already written down
 * here under `viva.study.<subjectId>`. This is that trick applied to the rest of
 * the record instead of only the conversation.
 *
 * Two jobs, in this order:
 *
 *   1. RENDER. Read the mirror before the network answers, so no screen is ever
 *      emptier than what the student actually did. Where the server and the
 *      mirror disagree about how much history exists, more history wins.
 *   2. REPLAY. Hand the record back to `POST /api/learner/sync` on load. That
 *      endpoint dedupes on `clientEventId`, replays the events through the one
 *      fold in src/lib/mastery.ts, and writes any subject the server has lost —
 *      which is what makes the next read on that lambda correct rather than
 *      just optimistic.
 *
 * Mastery is kept here for (1) and never sent for (2). The contract does not
 * accept client mastery numbers on purpose: replaying twice must not move the
 * map, and a browser must not be able to post itself a 100%.
 *
 * Identity is the browser, the same way the product's identity is: there is no
 * sign-in, one device is one student, and this inherits exactly the trust
 * boundary `viva.study.*` has shipped with since round 1.
 */

const KEY = "viva.record.v1";

/**
 * Caps, from the contract in src/app/api/learner/sync/route.ts. Inlined rather
 * than imported because src/lib/sync.ts pulls in the store and cannot enter a
 * client bundle; if those numbers move, these are the mirror of them.
 */
const MAX_EVENTS = 200;
const MAX_SUBJECTS = 10;
const MAX_SYNC_BYTES = 512_000;

/** An event plus the id the turn was posted with — the replay dedupe key. */
export type MirroredEvent = LearningEvent & { clientEventId?: string };

export type VivaRecord = {
  v: 1;
  mastery: Record<string, ConceptMastery>;
  events: MirroredEvent[];
  /** Only subjects the student built. Starters are compiled into the app. */
  subjects: Record<string, Subject>;
};

const EMPTY: VivaRecord = { v: 1, mastery: {}, events: [], subjects: {} };

/* ------------------------------- storage -------------------------------- */

/**
 * Is there writable storage at all?
 *
 * Private mode, a browser set to block site data, and a full quota all throw —
 * two of them on the read, before anything has been written. Probed once and
 * remembered, because every caller asks and the answer cannot change mid-page.
 */
let writable: boolean | null = null;

export function storageWorks(): boolean {
  if (writable !== null) return writable;
  try {
    window.localStorage.setItem(`${KEY}.probe`, "1");
    window.localStorage.removeItem(`${KEY}.probe`);
    writable = true;
  } catch {
    writable = false;
  }
  return writable;
}

/** The mirror, or an empty record. Never throws, never returns a partial shape. */
/**
 * The key terms of one subject the student built, for `keyterms_prompt`.
 *
 * Without DATABASE_URL a subject built two minutes ago is invisible to
 * whichever instance answers the next upload, so recognition bias went out
 * empty for exactly the vocabulary that needs it — their own. Returns nothing
 * for a starter subject, which the server can already resolve, and nothing
 * when storage is unreadable.
 */
export function keytermsFor(subjectId: string | null): string[] {
  if (!subjectId) return [];
  try {
    const terms = readRecord().subjects[subjectId]?.keyterms;
    return Array.isArray(terms) ? terms.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function readRecord(): VivaRecord {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<VivaRecord> | null;
    if (!parsed || parsed.v !== 1) return EMPTY;
    return {
      v: 1,
      mastery: isRecord<ConceptMastery>(parsed.mastery) ? parsed.mastery : {},
      events: Array.isArray(parsed.events) ? parsed.events.filter(hasId) : [],
      subjects: isRecord<Subject>(parsed.subjects) ? parsed.subjects : {},
    };
  } catch {
    // Private mode, or something else wrote nonsense under our key.
    return EMPTY;
  }
}

/**
 * Write it down, and give up quietly rather than break the page.
 *
 * A quota failure is not something a student can act on, so it is never shown.
 * What it gets instead is two attempts to make room, cheapest first: half the
 * event log, then the passage bodies — the only large thing in here, and the one
 * thing the server can always re-serve. The last attempt keeps the map, the
 * event log and the subject titles, which are the parts that vanish server-side.
 */
function writeRecord(next: VivaRecord): void {
  if (!storageWorks()) return;
  const attempts: VivaRecord[] = [
    next,
    { ...next, events: next.events.slice(0, Math.ceil(next.events.length / 2)) },
    { ...next, events: next.events.slice(0, 20), subjects: stripPassages(next.subjects) },
  ];
  for (const attempt of attempts) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(attempt));
      return;
    } catch {
      /* try the next, smaller one */
    }
  }
  // Out of room at every size: stop trying for the rest of this page.
  writable = false;
}

function stripPassages(subjects: Record<string, Subject>): Record<string, Subject> {
  return Object.fromEntries(
    Object.entries(subjects).map(([id, s]) => [
      id,
      { ...s, sources: s.sources.map((src) => ({ ...src, chunks: [] })) },
    ])
  );
}

function isRecord<T>(v: unknown): v is Record<string, T> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function hasId(e: unknown): e is MirroredEvent {
  return Boolean(e) && typeof (e as MirroredEvent).id === "string";
}

/* ------------------------------- merging -------------------------------- */

/**
 * Union of two event logs, newest first, deduped.
 *
 * `clientEventId` is the first key, because that is the one the browser minted
 * and the one the replay dedupes on: the same turn written by two lambdas comes
 * back with two server ids and one client id, and counting it twice would move
 * the map twice.
 */
function mergeEvents(server: MirroredEvent[], mirror: MirroredEvent[]): MirroredEvent[] {
  const out: MirroredEvent[] = [];
  const seen = new Set<string>();
  for (const e of [...server, ...mirror]) {
    if (!hasId(e)) continue;
    const key = e.clientEventId || e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out
    .sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)
    )
    .slice(0, MAX_EVENTS);
}

/**
 * Per concept, the copy that has folded more of this student's history.
 *
 * `exposureCount` is the comparator because the fold increments it exactly once
 * per event (src/lib/mastery.ts:39), so a bigger count means strictly more of
 * the session is in that record. `lastSeenAt` only breaks a tie.
 */
function mergeMastery(
  server: Record<string, ConceptMastery>,
  mirror: Record<string, ConceptMastery>
): Record<string, ConceptMastery> {
  const out: Record<string, ConceptMastery> = { ...mirror };
  for (const [id, s] of Object.entries(server ?? {})) {
    const m = out[id];
    if (!m) {
      out[id] = s;
      continue;
    }
    const fresher =
      s.exposureCount > m.exposureCount ||
      (s.exposureCount === m.exposureCount && s.lastSeenAt >= m.lastSeenAt);
    if (fresher) out[id] = s;
  }
  return out;
}

/** The subject-card / picker shape both /subjects and the pickers read. */
export type SubjectMetaLite = {
  id: string;
  code: string;
  title: string;
  subject: string;
  demo: boolean;
  builtBy: string | null;
  origin?: string;
  createdAt?: string;
  conceptCount: number;
  chunkCount: number;
  examCount: number;
  trapCount: number;
};

export function metaOf(s: Subject): SubjectMetaLite {
  return {
    id: s.id,
    code: s.code,
    title: s.title,
    subject: s.subject,
    demo: false,
    builtBy: s.builtBy,
    origin: s.origin,
    createdAt: s.createdAt,
    conceptCount: s.concepts.length,
    chunkCount: s.sources.reduce((n, src) => n + src.chunks.length, 0),
    examCount: s.examQuestions.length,
    trapCount: s.traps.length,
  };
}

/**
 * The concept shape, left open on purpose: /study reads `description` for the
 * detail panel and /today never does, so each page names what it needs and the
 * merge stays one function instead of two.
 */
export type ConceptLite = { id: string; name: string };

/** Exactly the fields GET /api/learner and POST /api/learner/sync share. */
export type LearnerPayload<C extends ConceptLite = ConceptLite> = {
  mastery: Record<string, ConceptMastery>;
  events: MirroredEvent[];
  concepts: C[];
  courses?: SubjectMetaLite[];
  durable?: boolean;
  storageNote?: string | null;
};

/**
 * Fold one learner payload into the mirror and hand back the union.
 *
 * `subjectId` scopes the result, not the write: a scoped response carries only
 * that subject's concepts and events, and folding it must not delete the other
 * subject's. The concepts fall back to the mirrored subject's own map, which is
 * what lets /study draw a subject the server has forgotten.
 */
export function mergeLearner<C extends ConceptLite>(
  server: LearnerPayload<C>,
  subjectId?: string | null
): LearnerPayload<C> {
  const mirror = readRecord();
  const mastery = mergeMastery(server.mastery ?? {}, mirror.mastery);
  const events = mergeEvents(Array.isArray(server.events) ? server.events : [], mirror.events);
  const mine = subjectId ? mirror.subjects[subjectId] : undefined;
  // The mirrored subject's own `ConceptDef` carries every field either page
  // reads; the cast is the one place that knowledge is asserted.
  const concepts: C[] = server.concepts?.length
    ? server.concepts
    : ((mine?.concepts ?? Object.values(mirror.subjects).flatMap((s) => s.concepts)) as unknown as C[]);

  writeRecord({ v: 1, mastery, events, subjects: mirror.subjects });

  const ids = new Set(concepts.map((c) => c.id));
  return {
    ...server,
    mastery: subjectId
      ? Object.fromEntries(Object.entries(mastery).filter(([id]) => ids.has(id)))
      : mastery,
    events: subjectId
      ? events.filter((e) => e.courseId === subjectId || (e.primaryConceptId && ids.has(e.primaryConceptId)))
      : events,
    concepts,
    courses: mergeSubjectList(server.courses ?? []),
  };
}

/** Record one turn the moment it lands, with the id the replay dedupes on. */
export function rememberEvent(event: LearningEvent, clientEventId: string): void {
  const mirror = readRecord();
  writeRecord({
    ...mirror,
    events: mergeEvents([{ ...event, clientEventId }], mirror.events),
  });
}

/** Fold a mastery map returned by a mutating route into the mirror. */
export function rememberMastery(mastery: Record<string, ConceptMastery>): void {
  const mirror = readRecord();
  writeRecord({ ...mirror, mastery: mergeMastery(mastery, mirror.mastery) });
}

/* ------------------------------ subjects -------------------------------- */

/**
 * Keep a subject the browser just built, before the first read can lose it.
 *
 * Oldest out at the cap, which is the same cap one sync request carries: a
 * subject the mirror cannot hand back is a subject the server cannot recover.
 */
export function rememberSubject(record: Subject): void {
  const mirror = readRecord();
  const subjects = { ...mirror.subjects, [record.id]: record };
  const ordered = Object.values(subjects).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  writeRecord({
    ...mirror,
    subjects: Object.fromEntries(ordered.slice(0, MAX_SUBJECTS).map((s) => [s.id, s])),
  });
}

/** Everything the server listed, plus every subject it has forgotten since. */
export function mergeSubjectList<T extends { id: string }>(server: T[]): (T | SubjectMetaLite)[] {
  const have = new Set(server.map((s) => s.id));
  const missing = Object.values(readRecord().subjects)
    .filter((s) => !have.has(s.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(metaOf);
  return [...server, ...missing];
}

export function mirroredSubject(subjectId: string | null | undefined): Subject | null {
  if (!subjectId) return null;
  return readRecord().subjects[subjectId] ?? null;
}

/** The passages of a mirrored subject, in rail order. */
export function mirroredChunks(subjectId: string | null | undefined): SourceChunk[] {
  const s = mirroredSubject(subjectId);
  return s ? s.sources.flatMap((src) => src.chunks) : [];
}

/* -------------------------------- replay -------------------------------- */

export type SyncResult = LearnerPayload & {
  sync?: { events: { applied: number; duplicate: number }; subjects: { applied: number } };
};

/**
 * Hand the record back, take the merged view in return.
 *
 * Trimmed to fit the contract's 512 KB before it is sent: events first (the
 * cheapest thing to lose, and the server already has the old ones), then the
 * oldest subjects. Sending nothing is a valid call — the reply is still the
 * authoritative snapshot, so this is also the plain read.
 *
 * Resolves to null on any failure. A record that could not be handed back is a
 * reason to render from the mirror, never a reason to show an error: the student
 * did the work and it is still on their screen.
 */
export async function syncRecord(subjectId?: string | null): Promise<SyncResult | null> {
  const mirror = readRecord();
  let events = mirror.events.slice(0, MAX_EVENTS);
  let subjects = Object.values(mirror.subjects)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_SUBJECTS);

  let body = JSON.stringify({ events, subjects });
  while (body.length > MAX_SYNC_BYTES && (events.length > 0 || subjects.length > 1)) {
    if (events.length > 0) events = events.slice(0, Math.floor(events.length / 2));
    else subjects = subjects.slice(0, subjects.length - 1);
    body = JSON.stringify({ events, subjects });
  }

  const query = subjectId ? `?subject=${encodeURIComponent(subjectId)}` : "";
  try {
    const res = await fetch(`/api/learner/sync${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) return null;
    return (await res.json()) as SyncResult;
  } catch {
    return null;
  }
}
