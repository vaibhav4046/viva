import { compoundMemory } from "@/lib/memory";
import { projectWeek, selectDailyPath, type WeekDay } from "@/lib/planner";
import type { ConceptMastery, LearningEvent } from "@/lib/types";
import type { PathSegment } from "./types";

/**
 * One snapshot in, the whole /today screen out.
 *
 * The page used to make four calls — /api/learner/path, /api/learner,
 * /api/learner/review and /api/learner/week — and print all four answers on one
 * screen. On Vercel each of those lands on whichever lambda is free, and the
 * file store lives in that lambda's own /tmp, so the four sections were reading
 * four different memories of the same student: a seven-minute plan naming two
 * concepts sat 400 px above "Nothing is tripping you up yet", and three
 * consecutive loads gave three different answers.
 *
 * They cannot disagree now, because they are no longer four answers. The page
 * fetches the learner state once and folds it here, with the same planner the
 * routes use — `selectDailyPath` and `projectWeek` are imported, not copied, so
 * the plan on screen is still the plan the server would have composed.
 *
 * The due list is the week projection with today removed. That is what "due"
 * has always meant on this screen, and taking it from the projection rather
 * than from a second call is what makes the strip and the list the same object:
 * a concept cannot be on Wednesday in one section and missing from the other.
 */

export type LearnerSnapshot = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: { id: string; name: string }[];
};

export type DueItem = {
  conceptId: string;
  conceptName: string;
  dueAt: string;
  priority: number;
  reason: string;
};

export type TodayView = {
  path: PathSegment[];
  minutes: number;
  week: WeekDay[];
  due: DueItem[];
  /** A compound-memory sentence about what keeps coming back, when there is one. */
  recurring: string | null;
  /** The concept behind that sentence — the map link, and the fallback line. */
  mixedUp: ConceptMastery | null;
  improved: ConceptMastery | null;
  /** False on a cold account: nothing has been said yet, so nothing is claimed. */
  hasHistory: boolean;
  nameOf: (id: string) => string;
};

export function deriveToday(snapshot: LearnerSnapshot, now: Date = new Date()): TodayView {
  const { mastery, events, concepts } = snapshot;
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? id;

  // The store's own review queue is a second round trip and, on Postgres, a
  // second source of truth. The ladder alone ranks the same concepts in the
  // same order, and it comes free with the snapshot already on the page.
  const input = { mastery, events, queue: [], concepts };
  const path = selectDailyPath(input);
  const week = projectWeek(input, now).days;

  const due: DueItem[] = week.slice(1).flatMap((day) =>
    day.segments.map((s) => ({
      conceptId: s.conceptId,
      conceptName: s.title,
      dueAt: day.date,
      // null, not 0: a concept you have never touched has no overdue-ness to
      // report, and "0% priority" reads as "ignore this" on exactly the rows
      // that are new material.
      priority: mastery[s.conceptId]?.reviewPriority ?? null,
      reason: s.reason,
    }))
  );

  const compound = compoundMemory(
    events.map((e) => ({
      intent: e.intent,
      primaryConceptId: e.primaryConceptId,
      cleanedTranscript: e.cleanedTranscript,
    })),
    Object.fromEntries(names)
  );

  const mixedUp =
    Object.values(mastery)
      .filter((m) => m.misconceptionCount > 0)
      .sort(
        (a, b) =>
          b.misconceptionCount - a.misconceptionCount ||
          b.reviewPriority - a.reviewPriority ||
          a.conceptId.localeCompare(b.conceptId)
      )[0] ?? null;

  const improved =
    Object.values(mastery)
      .filter((m) => m.lastSuccessfulRecallAt)
      .sort(
        (a, b) =>
          (b.lastSuccessfulRecallAt ?? "").localeCompare(a.lastSuccessfulRecallAt ?? "") ||
          a.conceptId.localeCompare(b.conceptId)
      )[0] ?? null;

  return {
    path,
    minutes: path.reduce((n, s) => n + s.minutes, 0),
    week,
    due,
    recurring: compound.find((s) => /confus/i.test(s)) ?? null,
    mixedUp,
    improved,
    hasHistory: events.length > 0,
    nameOf,
  };
}
