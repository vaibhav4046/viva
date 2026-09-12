import { COURSES } from "@/lib/courses";
import { bandLabelFor } from "@/lib/mastery";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

/**
 * Deterministic learner planner — ONE scheduler for the Daily Path and the
 * 7-day "Your week" projection.
 *
 * NO LLM: every function is a pure fold over the caller's own mastery, last 50
 * events and review queue. Identical inputs produce identical output; every tie
 * is broken by conceptId so ordering never depends on object iteration.
 *
 * Daily Path composition rules (fixed, in priority order):
 *   1. misconception — highest reviewPriority concept whose history contains a
 *      recorded incorrect/misconception event; queue membership preferred
 *      (3 min, inline recall).
 *   2. weak_concept  — lowest VIVA estimate among concepts seen in events
 *      (3 min, opens Study/demo).
 *   3. recall        — a concept with ≥1 successful recall (1 min, quick).
 *   4. teachback     — confusionCount > 0 and mastery > 0.5, i.e. a
 *      correction happened and should be proven (2 min, opens Exam teach tab).
 *   5. summary       — always last: 1 minute to write it down (capture).
 * Fixed minutes sum to exactly 10 when all five segments exist; thin history
 * yields a shorter, honest path, never padding.
 *
 * Spacing rule (reused by the week projection, never re-derived):
 *   - Queue items carry the store's own `dueAt` (the stores apply the one-day
 *     retrieval nudge documented in LEARNING_SCIENCE.md §5); the projection
 *     places each item on its stored due day.
 *   - Remaining ranked candidates escalate one per free future day in ladder
 *     order, keeping learning episodes at least a day apart.
 *
 * Per-event misconception signal: exam/teachback routes record a failed
 * attempt as intent claim/teachback with confusion 0.6 and an
 * `assessment: "incorrect"` field persisted by file/blob (pg migration 002).
 */

export type PathSegmentOut = {
  kind: "recall" | "weak_concept" | "misconception" | "teachback" | "summary";
  conceptId: string | null;
  conceptName?: string;
  courseId: string | null;
  minutes: number;
  why: string;
  action: "inline_recall" | "study" | "teachback" | "capture";
};

type EventWithAssessment = LearningEvent & {
  assessment?: "correct" | "partial" | "incorrect" | null;
};

export function isMisconceptionEvent(e: EventWithAssessment): boolean {
  if (e.assessment === "incorrect") return true;
  return (e.intent === "claim" || e.intent === "teachback") && e.confusion >= 0.6;
}

/** Which lab owns a concept id (ids are unique across labs). */
export function ownerCourse(conceptId: string | null): string | null {
  if (!conceptId) return null;
  for (const c of Object.values(COURSES)) {
    if (c.concepts.some((x) => x.id === conceptId)) return c.id;
  }
  return null;
}

export type QueueItem = { conceptId: string; dueAt?: string; priority?: number; reason?: string };

export type PlannerInput = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  queue: QueueItem[];
  concepts: { id: string; name: string }[];
};

export type CandidateKind = "misconception" | "weak_concept" | "recall" | "teachback";

export type RankedCandidate = {
  kind: CandidateKind;
  concept: ConceptMastery;
  why: string;
};

const RULE_ORDER: CandidateKind[] = ["misconception", "weak_concept", "recall", "teachback"];

/** One rule tier, sorted and excluding concepts already claimed by the ladder. */
function tierCandidates(input: PlannerInput, kind: CandidateKind, used: Set<string>): RankedCandidate[] {
  const { mastery, events, queue, concepts } = input;
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? id;

  if (kind === "misconception") {
    // Queue membership (the store's own "due" flag) is preferred when present;
    // mastery is the fallback so a single wrong answer still surfaces before
    // priority crosses the threshold.
    const queued = new Set(queue.map((q) => q.conceptId));
    return Object.values(mastery)
      .filter((m) => !used.has(m.conceptId) && events.some((e) => e.primaryConceptId === m.conceptId && isMisconceptionEvent(e)))
      .sort(
        (a, b) =>
          Number(queued.has(b.conceptId)) - Number(queued.has(a.conceptId)) ||
          b.reviewPriority - a.reviewPriority ||
          a.conceptId.localeCompare(b.conceptId)
      )
      .map((m) => {
        const wrong = Math.max(1, m.misconceptionCount);
        const conf = m.confusionCount;
        return {
          kind,
          concept: m,
          why: `You got “${nameOf(m.conceptId)}” wrong ${wrong === 1 ? "once" : `${wrong} times`}${conf > 0 ? ` and flagged it as confusing ${conf === 1 ? "once" : `${conf} times`}` : ""} — clear it before it sticks.`,
        };
      });
  }

  if (kind === "weak_concept") {
    const seen = new Set(events.map((e) => e.primaryConceptId).filter((id): id is string => Boolean(id)));
    return [...seen]
      .map((id) => ({ id, m: mastery[id] }))
      .filter((x): x is { id: string; m: ConceptMastery } => Boolean(x.m) && !used.has(x.id))
      .sort((a, b) => a.m.mastery - b.m.mastery || a.id.localeCompare(b.id))
      .map(({ m }) => ({
        kind,
        concept: m,
        why: `The one you are least sure of so far. A few minutes here moves it.`,
      }));
  }

  if (kind === "recall") {
    return Object.values(mastery)
      .filter((m) => m.successfulRecallCount >= 1 && !used.has(m.conceptId))
      .sort(
        (a, b) =>
          b.mastery - a.mastery ||
          (b.lastSuccessfulRecallAt ?? "").localeCompare(a.lastSuccessfulRecallAt ?? "") ||
          a.conceptId.localeCompare(b.conceptId)
      )
      .map((m) => ({
        kind,
        concept: m,
        why: `You recalled “${nameOf(m.conceptId)}” correctly ${m.successfulRecallCount} time${m.successfulRecallCount === 1 ? "" : "s"} — one quick pass keeps it.`,
      }));
  }

  return Object.values(mastery)
    .filter((m) => m.confusionCount > 0 && m.mastery > 0.5 && !used.has(m.conceptId))
    .sort((a, b) => b.mastery - a.mastery || a.conceptId.localeCompare(b.conceptId))
    .map((m) => ({
      kind,
      concept: m,
      why: `You were confused by “${nameOf(m.conceptId)}” and corrected it — now ${bandLabelFor(m)}. Prove you can explain it.`,
    }));
}

/** The whole ladder ranked across all candidates (week projection order). */
export function rankCandidates(input: PlannerInput): RankedCandidate[] {
  const used = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const kind of RULE_ORDER) {
    for (const candidate of tierCandidates(input, kind, used)) {
      used.add(candidate.concept.conceptId);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * The 10-minute path — first candidate of each rule (each pick excludes the
 * previous picks, exactly as the original route did), summary always last.
 */
export function selectDailyPath(input: PlannerInput): PathSegmentOut[] {
  const names = new Map(input.concepts.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const used = new Set<string>();
  const path: PathSegmentOut[] = [];

  const misc = tierCandidates(input, "misconception", used)[0];
  if (misc) {
    used.add(misc.concept.conceptId);
    path.push({
      kind: "misconception",
      conceptId: misc.concept.conceptId,
      conceptName: nameOf(misc.concept.conceptId),
      courseId: ownerCourse(misc.concept.conceptId),
      minutes: 3,
      why: misc.why,
      action: "inline_recall",
    });
  }

  const weak = tierCandidates(input, "weak_concept", used)[0];
  if (weak) {
    used.add(weak.concept.conceptId);
    path.push({
      kind: "weak_concept",
      conceptId: weak.concept.conceptId,
      conceptName: nameOf(weak.concept.conceptId),
      courseId: ownerCourse(weak.concept.conceptId),
      minutes: 3,
      why: weak.why,
      action: "study",
    });
  }

  const recall = tierCandidates(input, "recall", used)[0];
  if (recall) {
    used.add(recall.concept.conceptId);
    path.push({
      kind: "recall",
      conceptId: recall.concept.conceptId,
      conceptName: nameOf(recall.concept.conceptId),
      courseId: ownerCourse(recall.concept.conceptId),
      minutes: 1,
      why: recall.why,
      action: "inline_recall",
    });
  }

  const teach = tierCandidates(input, "teachback", used)[0];
  if (teach) {
    used.add(teach.concept.conceptId);
    path.push({
      kind: "teachback",
      conceptId: teach.concept.conceptId,
      conceptName: nameOf(teach.concept.conceptId),
      courseId: ownerCourse(teach.concept.conceptId),
      minutes: 2,
      why: teach.why,
      action: "teachback",
    });
  }

  // Nothing has happened yet: an honest empty plan beats a one-line plan that
  // implies a session took place. The screen says so in its own words.
  if (path.length === 0) return [];

  path.push({
    kind: "summary",
    conceptId: null,
    courseId: null,
    minutes: 1,
    why: "1 minute to write it down — retrieval beats re-reading.",
    action: "capture",
  });

  return path;
}

export const WEEK_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type WeekSegment = { conceptId: string; title: string; reason: string };
export type WeekDay = { date: string; label: string; segments: WeekSegment[]; count: number };
export type WeekProjection = { days: WeekDay[]; generatedAt: string };

function clampDay(diffMs: number): number {
  const rounded = Math.round(diffMs / DAY_MS);
  return Math.max(0, Math.min(WEEK_DAYS - 1, rounded));
}

/**
 * 7-day projection from the current review state:
 *   - today is exactly selectDailyPath() — the same plan /today renders;
 *   - queue items land on their stored due day (overdue → today);
 *   - the remaining ladder candidates fill free future days in rank order,
 *     one per day, so later reviews are spaced at least a day apart.
 * A concept appears at most once across the week.
 */
export function projectWeek(input: PlannerInput, now: Date): WeekProjection {
  const nowMs = now.getTime();
  const names = new Map(input.concepts.map((c) => [c.id, c.name]));
  const titleOf = (id: string) => names.get(id) ?? id;
  const items: WeekSegment[][] = Array.from({ length: WEEK_DAYS }, () => []);
  const placed = new Set<string>();

  for (const seg of selectDailyPath(input)) {
    if (!seg.conceptId || placed.has(seg.conceptId)) continue;
    placed.add(seg.conceptId);
    items[0].push({ conceptId: seg.conceptId, title: titleOf(seg.conceptId), reason: seg.why });
  }

  const queue = [...input.queue].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.conceptId.localeCompare(b.conceptId)
  );
  for (const q of queue) {
    if (placed.has(q.conceptId)) continue;
    placed.add(q.conceptId);
    const diff = q.dueAt ? Date.parse(q.dueAt) - nowMs : DAY_MS;
    const day = Number.isFinite(diff) ? clampDay(diff) : 1;
    items[day].push({
      conceptId: q.conceptId,
      title: titleOf(q.conceptId),
      reason: q.reason ?? "Due for review",
    });
  }

  let slot = 1;
  for (const candidate of rankCandidates(input)) {
    const { conceptId } = candidate.concept;
    if (placed.has(conceptId)) continue;
    placed.add(conceptId);
    while (slot < WEEK_DAYS - 1 && items[slot].length > 0) slot++;
    items[slot].push({ conceptId, title: titleOf(conceptId), reason: candidate.why });
    slot++;
  }

  const days: WeekDay[] = [];
  for (let d = 0; d < WEEK_DAYS; d++) {
    const date = new Date(nowMs + d * DAY_MS);
    days.push({
      date: date.toISOString().slice(0, 10),
      label: d === 0 ? "Today" : d === 1 ? "Tomorrow" : WEEKDAY_NAMES[date.getUTCDay()],
      segments: items[d],
      count: items[d].length,
    });
  }
  return { days, generatedAt: new Date(nowMs).toISOString() };
}
