import { COURSES } from "@/lib/courses";
import { bandLabelFor, masteryState } from "@/lib/mastery";
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
 *   1. misconception — highest reviewPriority concept carrying a wrong answer
 *      that has not been cleared since; queue membership preferred
 *      (3 min, inline recall).
 *   2. weak_concept  — the lowest-scoring concept seen in events, excluding
 *      ones already recalled right and holding (3 min, opens Study/demo).
 *   3. recall        — a concept with ≥1 successful recall (1 min, quick).
 *   4. teachback     — a concept the learner can already answer on and that is
 *      holding: say the whole thing out loud (2 min, opens Exam teach tab).
 *   5. fill          — those four rules take ONE concept each, which is why a
 *      learner with one answer behind them used to get "4 of 10 min planned"
 *      and a single real step. The rest of the nine concept minutes go, in
 *      order, to the remaining ranked candidates (1 min each), concepts of
 *      this subject nobody has opened (2 min: meet it, answer, read the
 *      correction), and finally teachbacks (2 min) once there is nothing left
 *      to ask. Every step says which of those it is.
 *      A learner with NO history still gets nothing — see selectDailyPath.
 *   6. summary       — always last, and only above one real step: 1 minute to
 *      write down what changed, naming the concepts it changed about.
 *
 * Spacing rule (reused by the week projection, never re-derived):
 *   - Queue items carry the store's own `dueAt` (the stores apply the one-day
 *     retrieval nudge documented in LEARNING_SCIENCE.md §5); the projection
 *     places each item on its stored due day.
 *   - Everything else rides the 1/2/4/7-day ladder in reviewIntervalDays(),
 *     measured from the learner's own last correct answer. A concept answered
 *     correctly today is anchored to today and comes back later in the SAME
 *     week — being on today's plan no longer erases it from the projection,
 *     which is what left "Nothing projected" under every future day.
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

/**
 * Everything the planner needs to know about a shipped concept, indexed once.
 *
 * `name` is the fallback when the caller's concept list does not cover the id.
 * In "all subjects" mode the list is one subject's, while mastery and events
 * span every subject, so /today printed `bio_microscopy` as a step heading.
 * `hasQuestion` keeps an inline recall off a concept the exam has nothing to
 * ask about (a subject can carry more concepts than questions).
 */
type ConceptFacts = { courseId: string; name: string; hasQuestion: boolean };

let conceptFacts: Map<string, ConceptFacts> | null = null;

function factsIndex(): Map<string, ConceptFacts> {
  if (conceptFacts) return conceptFacts;
  const index = new Map<string, ConceptFacts>();
  for (const course of Object.values(COURSES)) {
    const asked = new Set(course.examQuestions.map((q) => q.conceptId));
    for (const c of course.concepts) {
      if (!index.has(c.id)) index.set(c.id, { courseId: course.id, name: c.name, hasQuestion: asked.has(c.id) });
    }
  }
  conceptFacts = index;
  return index;
}

/** Which lab owns a concept id (ids are unique across labs). */
export function ownerCourse(conceptId: string | null): string | null {
  if (!conceptId) return null;
  return factsIndex().get(conceptId)?.courseId ?? null;
}

/**
 * A name for a concept id: the caller's own list first, then anything VIVA
 * ships, and only then the raw id — which a student should never see.
 */
function namerFor(concepts: { id: string; name: string }[]): (id: string) => string {
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  return (id: string) => names.get(id) ?? factsIndex().get(id)?.name ?? id;
}

/**
 * Can VIVA put a question to this concept? Unknown ids belong to a subject the
 * learner built, whose questions live in the store rather than here, so they
 * get the benefit of the doubt; a shipped concept has to actually be covered.
 */
function askable(conceptId: string): boolean {
  const facts = factsIndex().get(conceptId);
  return !facts || facts.hasQuestion;
}

/**
 * A wrong answer counts against a concept until the learner gets it right
 * again. Without that second half, one bad Tuesday pins a concept to the top
 * of "clear this first" forever, however many times it has been nailed since.
 */
export function unresolvedMisconception(m: ConceptMastery, events: EventWithAssessment[]): boolean {
  let latestWrong = "";
  for (const e of events) {
    if (e.primaryConceptId !== m.conceptId || !isMisconceptionEvent(e)) continue;
    if (e.createdAt > latestWrong) latestWrong = e.createdAt;
  }
  if (!latestWrong) return false;
  return !m.lastSuccessfulRecallAt || m.lastSuccessfulRecallAt < latestWrong;
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

/** Sitting at "Getting there" or better — the same thresholds the map shows. */
function holding(m: ConceptMastery): boolean {
  const state = masteryState(m.mastery);
  return state === "strong" || state === "developing";
}

/** One rule tier, sorted and excluding concepts already claimed by the ladder. */
function tierCandidates(input: PlannerInput, kind: CandidateKind, used: Set<string>): RankedCandidate[] {
  const { mastery, events, queue, concepts } = input;
  const nameOf = namerFor(concepts);

  if (kind === "misconception") {
    // Queue membership (the store's own "due" flag) is preferred when present;
    // mastery is the fallback so a single wrong answer still surfaces before
    // priority crosses the threshold.
    const queued = new Set(queue.map((q) => q.conceptId));
    return Object.values(mastery)
      .filter((m) => !used.has(m.conceptId) && unresolvedMisconception(m, events))
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
      // "The one you are least sure of" is a sentence about the learner, and it
      // was landing on the concept they had just answered correctly, because a
      // one-concept history makes every concept the weakest one. A concept they
      // have recalled right and that is still holding falls through to the
      // recall tier, which says something true about it.
      .filter((x) => !(x.m.successfulRecallCount > 0 && holding(x.m)))
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

  /*
   * Teach it back. This used to require a recorded confusion, so a learner who
   * simply got things right never saw the step the product is named for — and
   * once a small subject's questions run out, recall has nothing left to ask
   * while explaining it out loud still has everything.
   */
  return Object.values(mastery)
    .filter((m) => m.successfulRecallCount > 0 && holding(m) && !used.has(m.conceptId))
    .sort((a, b) => b.mastery - a.mastery || a.conceptId.localeCompare(b.conceptId))
    .map((m) => ({
      kind,
      concept: m,
      why:
        m.confusionCount > 0
          ? `You were confused by “${nameOf(m.conceptId)}” and corrected it — now ${bandLabelFor(m)}. Prove you can explain it.`
          : `You can answer on “${nameOf(m.conceptId)}” — now ${bandLabelFor(m)}. Say the whole thing out loud and see if the explanation holds.`,
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

/** Ten minutes, one of which closes the session by writing it down. */
export const PATH_MINUTES = 10;
const SUMMARY_MINUTES = 1;
const CONCEPT_MINUTES = PATH_MINUTES - SUMMARY_MINUTES;
/** One question on something already met. */
const KNOWN_MINUTES = 1;
/** One question on something never opened: read it, answer, read the correction. */
const NEW_MINUTES = 2;
/** Saying the whole thing out loud, which is slower than answering one question. */
const TEACHBACK_MINUTES = 2;

/**
 * The 10-minute path — first candidate of each rule (each pick excludes the
 * previous picks, exactly as the original route did), then 1-minute recalls
 * until the nine concept minutes are spent, then the summary.
 */
export function selectDailyPath(input: PlannerInput): PathSegmentOut[] {
  const nameOf = namerFor(input.concepts);
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

  /*
   * Fill the rest of the ten minutes with real retrieval.
   *
   * Four rules, one concept each, is a three-to-nine minute plan — and a
   * learner with one answer behind them got three minutes of it, over a meter
   * reading "4 of 10 min planned". The rest is one question per step, answered
   * in the panel on this page: a minute for a concept they have already met,
   * two for one they have not (meeting it is part of the work), taken first
   * from the ladder's own remaining candidates and then from the concepts the
   * subject shipped with. Nothing here invents a history — an untouched
   * concept is described as untouched, and a plan can still end short when the
   * subject has run out of things to ask.
   */
  let spent = path.reduce((n, s) => n + s.minutes, 0);
  const addRecall = (conceptId: string, minutes: number, why: string) => {
    used.add(conceptId);
    spent += minutes;
    path.push({
      kind: "recall",
      conceptId,
      conceptName: nameOf(conceptId),
      courseId: ownerCourse(conceptId),
      minutes,
      why,
      action: "inline_recall",
    });
  };

  for (const candidate of rankCandidates(input)) {
    if (spent + KNOWN_MINUTES > CONCEPT_MINUTES) break;
    const { conceptId } = candidate.concept;
    if (used.has(conceptId) || !askable(conceptId)) continue;
    // The weak tier's own sentence is "the one you are least sure of", which is
    // true of one concept and nonsense printed three times down a page.
    const why =
      candidate.kind === "weak_concept"
        ? `Last time, “${nameOf(conceptId)}” came out ${bandLabelFor(candidate.concept).toLowerCase()} — one question to move it.`
        : candidate.why;
    addRecall(conceptId, KNOWN_MINUTES, why);
  }

  for (const concept of input.concepts) {
    if (spent + NEW_MINUTES > CONCEPT_MINUTES) break;
    if (used.has(concept.id) || (input.mastery[concept.id]?.exposureCount ?? 0) > 0) continue;
    if (!askable(concept.id)) continue;
    addRecall(
      concept.id,
      NEW_MINUTES,
      `You have not said anything about “${concept.name}” yet — one question before you read it. A cold attempt sticks better than another pass over the page.`
    );
  }

  /*
   * Tail of the session: explain what you can already answer. A subject with
   * six concepts and four questions runs out of things to ask after one
   * session, and a five-minute plan of repeat questions is the thin screen
   * again — saying the whole thing out loud is the work that is left.
   */
  for (const candidate of tierCandidates(input, "teachback", used)) {
    if (spent + TEACHBACK_MINUTES > CONCEPT_MINUTES) break;
    const { conceptId } = candidate.concept;
    used.add(conceptId);
    spent += TEACHBACK_MINUTES;
    path.push({
      kind: "teachback",
      conceptId,
      conceptName: nameOf(conceptId),
      courseId: ownerCourse(conceptId),
      minutes: TEACHBACK_MINUTES,
      why: candidate.why,
      action: "teachback",
    });
  }

  /*
   * "Write it down" is a closing step, not a plan. It was half of a two-step
   * ten-minute path, which is what made the whole screen read as filler, so it
   * only appears above real work — and it names what to write about.
   */
  if (path.length < 2) return path;
  const wrote = path
    .map((s) => s.conceptName)
    .filter((n): n is string => Boolean(n))
    .slice(0, 2);
  path.push({
    kind: "summary",
    conceptId: null,
    courseId: null,
    minutes: SUMMARY_MINUTES,
    why: wrote.length
      ? `1 minute, in your own words: what changed today about ${wrote.join(" and ")}? Writing it beats re-reading it.`
      : "1 minute to write it down — writing it beats re-reading it.",
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

/** The expanding ladder: each correct answer buys a longer gap. */
const LADDER_DAYS = [1, 2, 4, 7];

/**
 * How many days until a concept should come back, from its own record.
 *
 * A wrong answer that has not been cleared comes back tomorrow while it is
 * still fresh; everything else stretches 1 → 2 → 4 → 7 as the learner keeps
 * getting it right. This is the whole spaced-repetition promise the landing
 * page makes, and until now nothing computed it: the projection just spread
 * leftover candidates across free days, so the concept a learner had just
 * answered correctly was on today's plan and nowhere else in the week.
 */
export function reviewIntervalDays(m: ConceptMastery, events: EventWithAssessment[]): number {
  if (unresolvedMisconception(m, events)) return LADDER_DAYS[0];
  return LADDER_DAYS[Math.min(m.successfulRecallCount, LADDER_DAYS.length - 1)];
}

function spacedReason(m: ConceptMastery, interval: number, wrong: boolean): string {
  if (wrong) return "You got this wrong — it comes back tomorrow, while it is still fresh.";
  if (m.successfulRecallCount === 0) return `Seen but not yet said back — one question in ${dayWord(interval)}.`;
  const times = m.successfulRecallCount === 1 ? "once" : `${m.successfulRecallCount} times`;
  return `Recalled right ${times} — back in ${dayWord(interval)} to keep it.`;
}

const dayWord = (n: number) => (n === 1 ? "a day" : `${n} days`);

/**
 * 7-day projection from the current review state:
 *   - today is exactly selectDailyPath() — the same plan /today renders;
 *   - queue items land on their stored due day (overdue → today);
 *   - every concept with a record then takes its next ladder day, measured
 *     from its last correct answer — or from today when today's plan already
 *     covers it, which is how a concept answered correctly this morning shows
 *     up again later this week instead of vanishing from the projection.
 * A concept appears at most once in the future, and at most once more on today.
 */
export function projectWeek(input: PlannerInput, now: Date): WeekProjection {
  const nowMs = now.getTime();
  const titleOf = namerFor(input.concepts);
  const items: WeekSegment[][] = Array.from({ length: WEEK_DAYS }, () => []);
  const onToday = new Set<string>();
  const scheduled = new Set<string>();

  for (const seg of selectDailyPath(input)) {
    if (!seg.conceptId || onToday.has(seg.conceptId)) continue;
    onToday.add(seg.conceptId);
    items[0].push({ conceptId: seg.conceptId, title: titleOf(seg.conceptId), reason: seg.why });
  }

  const queue = [...input.queue].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.conceptId.localeCompare(b.conceptId)
  );
  for (const q of queue) {
    if (scheduled.has(q.conceptId)) continue;
    const diff = q.dueAt ? Date.parse(q.dueAt) - nowMs : DAY_MS;
    const day = Number.isFinite(diff) ? clampDay(diff) : 1;
    // Today's plan already carries it; the ladder below gives it its next day.
    if (day === 0 && onToday.has(q.conceptId)) continue;
    scheduled.add(q.conceptId);
    items[day].push({
      conceptId: q.conceptId,
      title: titleOf(q.conceptId),
      reason: q.reason ?? "Due for review",
    });
  }

  /*
   * The ladder. Everything the learner has actually touched, plus everything
   * today's plan puts in front of them — a concept on today's plan has no
   * record yet, and leaving it out is how "TOMORROW / Nothing projected" sat
   * under a plan whose whole point is that it comes back.
   */
  const touched = Object.values(input.mastery)
    .filter((m) => m.exposureCount > 0)
    .map((m) => m.conceptId);
  for (const conceptId of [...new Set([...touched, ...onToday])].sort()) {
    if (scheduled.has(conceptId)) continue;
    const m = input.mastery[conceptId];
    const wrong = m ? unresolvedMisconception(m, input.events) : false;
    const interval = m ? reviewIntervalDays(m, input.events) : LADDER_DAYS[0];
    // Anchored on today when today's plan covers it, otherwise on the last
    // time the learner actually got it right.
    const anchor = onToday.has(conceptId) ? nowMs : Date.parse(m.lastSuccessfulRecallAt ?? m.lastSeenAt);
    if (!Number.isFinite(anchor)) continue;
    // Overdue lands on tomorrow, not today: today's plan is already composed
    // above and this concept did not make it into the ten minutes.
    const day = Math.max(1, Math.round((anchor + interval * DAY_MS - nowMs) / DAY_MS));
    if (day > WEEK_DAYS - 1) continue;
    scheduled.add(conceptId);
    items[day].push({
      conceptId,
      title: titleOf(conceptId),
      reason: m
        ? spacedReason(m, interval, wrong)
        : `First met on today's plan — the check-back is ${dayWord(interval)} from now.`,
    });
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
