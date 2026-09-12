import type { EventStore } from "@/lib/store/repo";
import { err } from "@/lib/types";
import { COURSES, getCourse } from "./index";
import type { Course, Subject } from "./types";

/**
 * One place that answers "what am I studying".
 *
 * Two kinds of subject exist: the starters we ship (in the course registry)
 * and the ones a student made from their own notes (in their own store rows).
 * Every route resolves through here, so no generic code has to know that the
 * default lab happens to be about transformers.
 */

const MAX_KEYTERMS = 100;

/** Concept names and their aliases, deduped, capped for the dictation call. */
export function keytermsFrom(concepts: { name: string; aliases: string[] }[], cap = MAX_KEYTERMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of concepts) {
    for (const term of [c.name, ...c.aliases]) {
      const key = term.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term.trim());
      if (out.length === cap) return out;
    }
  }
  return out;
}

/** A shipped course, wearing the subject shape the rest of the app reads. */
export function starterSubject(course: Course): Subject {
  return {
    ...course,
    demo: true,
    ownerId: "system",
    createdAt: "2026-09-01T00:00:00.000Z",
    origin: "starter",
    builtBy: null,
    keyterms: keytermsFrom(course.concepts),
    languageCodes: ["en"],
  };
}

export function isStarterId(id: string | null | undefined): boolean {
  return Boolean(id && COURSES[id]);
}

/** An id that named a subject VIVA cannot produce. Never a different subject. */
export class SubjectNotFoundError extends Error {
  readonly code = "SUBJECT_NOT_FOUND";
  constructor(readonly subjectId: string) {
    super(`subject ${subjectId} does not resolve for this learner`);
    this.name = "SubjectNotFoundError";
  }
}

/**
 * Resolve an id to the caller's subject or a starter — and nothing else.
 *
 * This used to end `return starterSubject(getCourse(id))`, and `getCourse`
 * falls back to the default lab for any id it does not know. So three
 * different situations — no id at all, an id that is somebody else's, and an
 * id whose subject is gone — collapsed into one, and a student following their
 * own bookmark was confidently taught Transformers Week 4 with real citations
 * and no error anywhere. A bookmark, a second device or a deleted subject all
 * did it, with or without a database.
 *
 * Now: no id means the default starter, a starter id means that starter, and
 * anything else that does not resolve raises `SubjectNotFoundError` so the
 * route can 404 and the screen can say the subject is not here any more.
 */
export async function resolveSubject(
  store: EventStore,
  userId: string,
  id: string | null | undefined
): Promise<Subject> {
  if (!id) return starterSubject(getCourse(null));
  if (COURSES[id]) return starterSubject(COURSES[id]);
  const owned = await store.getSubject(userId, id);
  if (owned) return owned;
  throw new SubjectNotFoundError(id);
}

/**
 * Turn that into the one coded response every route returns for it. Anything
 * else is a real failure and is rethrown rather than dressed up as a 404.
 */
export function subjectMissing(error: unknown): Response {
  if (error instanceof SubjectNotFoundError) {
    return err(
      "SUBJECT_NOT_FOUND",
      "That subject isn't here any more. Open one from your subjects and carry on there.",
      false,
      404
    );
  }
  throw error;
}

/** What a picker needs: no chunk bodies, no question text. */
export type SubjectMeta = {
  id: string;
  code: string;
  title: string;
  subject: string;
  demo: boolean;
  origin: Subject["origin"];
  builtBy: Subject["builtBy"];
  createdAt: string;
  conceptCount: number;
  chunkCount: number;
  examCount: number;
  trapCount: number;
};

export function subjectMeta(s: Subject): SubjectMeta {
  return {
    id: s.id,
    code: s.code,
    title: s.title,
    subject: s.subject,
    demo: s.demo,
    origin: s.origin,
    builtBy: s.builtBy,
    createdAt: s.createdAt,
    conceptCount: s.concepts.length,
    chunkCount: s.sources.reduce((n, src) => n + src.chunks.length, 0),
    examCount: s.examQuestions.length,
    trapCount: s.traps.length,
  };
}

/** Starters first, then the caller's own, newest first. */
export async function listSubjectsFor(store: EventStore, userId: string): Promise<SubjectMeta[]> {
  const starters = Object.values(COURSES).map((c) => subjectMeta(starterSubject(c)));
  let owned: Subject[] = [];
  try {
    owned = await store.listSubjects(userId);
  } catch {
    owned = [];
  }
  const mine = owned
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(subjectMeta);
  return [...starters, ...mine];
}

/**
 * Which subject owns a concept id. Used when a plan or a review queue names a
 * concept from a subject other than the one currently open — answering from
 * the open subject would grade against the wrong material.
 */
export async function findSubjectOwning(
  store: EventStore,
  userId: string,
  conceptId: string | null
): Promise<Subject | null> {
  if (!conceptId) return null;
  for (const course of Object.values(COURSES)) {
    if (course.concepts.some((c) => c.id === conceptId)) return starterSubject(course);
  }
  const owned = await store.listSubjects(userId).catch(() => [] as Subject[]);
  return owned.find((s) => s.concepts.some((c) => c.id === conceptId)) ?? null;
}
