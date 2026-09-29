import { blankMastery, reduceMastery } from "@/lib/mastery";
import type { ConceptMastery } from "@/lib/types";

/**
 * Which concept the examiner asks about next, and what kind of question.
 *
 * A pure function of three things: the learner's stored mastery, the concepts
 * of the subject, and the results of the questions already asked in this exam.
 * Nothing here calls a model. The oral tool route runs it after each checked
 * answer and hands the result to the examiner as `next_question`, so the
 * choice comes from code and the model only phrases it.
 *
 * Rules, in order:
 *  1. First question: the weakest concept, as a recall question.
 *  2. After a miss or a partial answer, stay on that concept, at most
 *     MAX_STAY questions in a row, so a wrong answer is followed up and not
 *     answered with a change of subject. Then move on.
 *  3. After a correct or unsettled answer, go to the weakest concept.
 *  4. The kind rotates recall, why, apply. After an incorrect answer it steps
 *     back to recall, because the learner has to say the fact before applying it.
 *  5. A concept already asked MAX_PER_CONCEPT times is skipped while any other
 *     concept remains, so one weak concept cannot take the whole exam.
 *
 * Weakest means lowest stored mastery. Ties go to the concept asked fewer
 * times in this exam, then higher review priority, then the subject's order.
 */

export type QuestionKind = "recall" | "why" | "apply";
export const QUESTION_KINDS: readonly QuestionKind[] = ["recall", "why", "apply"];

/** What one asked question came to. `unsettled` is a claim the material did not settle. */
export type TurnResult = "correct" | "partial" | "incorrect" | "unsettled";

export type Turn = { conceptId: string | null; result: TurnResult };

export type ConceptRef = { id: string; name: string };

export type NextQuestion = {
  conceptId: string;
  conceptName: string;
  kind: QuestionKind;
  /** One plain sentence saying why, in words the examiner may use aloud. */
  reason: string;
};

export const MAX_STAY = 2;
export const MAX_PER_CONCEPT = 3;

const KIND_WORDS: Record<QuestionKind, string> = {
  recall: "a recall question",
  why: "a why question",
  apply: "an application question",
};

/** The verdicts a tool returns, mapped to the four results this module reasons about. */
export function turnResultOf(
  v: { kind: "claim"; verdict: "supported" | "contradicted" | "not_in_material" } | { kind: "answer"; grade: "correct" | "partial" | "incorrect" }
): TurnResult {
  if (v.kind === "answer") return v.grade;
  return v.verdict === "supported" ? "correct" : v.verdict === "contradicted" ? "incorrect" : "unsettled";
}

/** Fold one result into a copy of the mastery map with the same reducer the learner map uses. */
export function applyTurn(
  mastery: Record<string, ConceptMastery>,
  conceptId: string | null,
  result: TurnResult,
  now: string
): Record<string, ConceptMastery> {
  if (!conceptId) return mastery;
  const prev = mastery[conceptId] ?? blankMastery(conceptId, now);
  const { next } = reduceMastery(prev, {
    intent: "claim",
    createdAt: now,
    assessment: result === "unsettled" ? null : result,
    masterySignal: result === "unsettled" ? "flat" : null,
  });
  return { ...mastery, [conceptId]: next };
}

function rotate(kind: QuestionKind): QuestionKind {
  return QUESTION_KINDS[(QUESTION_KINDS.indexOf(kind) + 1) % QUESTION_KINDS.length];
}

/** The kind of the question that produced the last turn, replayed from the results. */
function lastKind(turns: Turn[]): QuestionKind {
  let kind: QuestionKind = "recall";
  for (const t of turns.slice(0, -1)) kind = t.result === "incorrect" ? "recall" : rotate(kind);
  return kind;
}

function trailingOn(turns: Turn[], conceptId: string | null): number {
  let n = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i].conceptId === conceptId; i--) n += 1;
  return n;
}

/** Concepts weakest first. Exported so the prompt and the chooser rank the same way. */
export function rankWeakest(
  concepts: ConceptRef[],
  mastery: Record<string, ConceptMastery>,
  turns: Turn[] = []
): ConceptRef[] {
  const asked = (id: string) => turns.filter((t) => t.conceptId === id).length;
  const level = (id: string) => mastery[id]?.mastery ?? 0.5;
  const priority = (id: string) => mastery[id]?.reviewPriority ?? 0.5;
  return concepts
    .map((c, index) => ({ c, index }))
    .sort(
      (a, b) =>
        level(a.c.id) - level(b.c.id) ||
        asked(a.c.id) - asked(b.c.id) ||
        priority(b.c.id) - priority(a.c.id) ||
        a.index - b.index
    )
    .map((x) => x.c);
}

export function chooseNext(input: {
  concepts: ConceptRef[];
  mastery: Record<string, ConceptMastery>;
  turns: Turn[];
}): NextQuestion | null {
  const { concepts, mastery, turns } = input;
  if (concepts.length === 0) return null;
  const ranked = rankWeakest(concepts, mastery, turns);
  const last = turns.at(-1) ?? null;
  const byId = new Map(concepts.map((c) => [c.id, c]));

  if (!last) {
    const first = ranked[0];
    return {
      conceptId: first.id,
      conceptName: first.name,
      kind: "recall",
      reason: `Start on ${first.name}, the weakest concept on the stored map.`,
    };
  }

  const kind: QuestionKind = last.result === "incorrect" ? "recall" : rotate(lastKind(turns));
  const lastConcept = last.conceptId ? byId.get(last.conceptId) ?? null : null;
  const stay = trailingOn(turns, last.conceptId);

  if (lastConcept && (last.result === "incorrect" || last.result === "partial") && stay < MAX_STAY) {
    const why = last.result === "incorrect" ? "was not right" : "was only partly right";
    const step = last.result === "incorrect" ? "step back to" : "ask";
    return {
      conceptId: lastConcept.id,
      conceptName: lastConcept.name,
      kind,
      reason: `The last answer on ${lastConcept.name} ${why}, so stay on it and ${step} ${KIND_WORDS[kind]}.`,
    };
  }

  const asked = (id: string) => turns.filter((t) => t.conceptId === id).length;
  const fresh = ranked.filter((c) => asked(c.id) < MAX_PER_CONCEPT && !(c.id === last.conceptId && stay >= MAX_STAY));
  const pool = fresh.length > 0 ? fresh : ranked;
  const pick = pool[0];
  const moved = pick.id !== last.conceptId;
  return {
    conceptId: pick.id,
    conceptName: pick.name,
    kind,
    reason: moved
      ? `Move to ${pick.name}, the weakest concept now, with ${KIND_WORDS[kind]}.`
      : `${pick.name} is still the weakest concept, so ask ${KIND_WORDS[kind]} on it.`,
  };
}
