import type { ConceptMastery, LearningEvent } from "@/lib/types";
import { applyTurn, chooseNext, type ConceptRef, type NextQuestion, type Turn, type TurnResult } from "./next-concept";

/**
 * Glue between the stored record and the chooser: rebuild this exam's turns
 * from the events the tool route already writes, add the answer that was just
 * checked, and return the next concept and question kind for the examiner.
 */

/** What the examiner reads in a tool result. Field names are the wire format. */
export type NextFocus = { concept: string; concept_id: string; kind: NextQuestion["kind"]; reason: string };

/** This exam's checked answers, oldest first, from the events written for this session id. */
export function turnsFromEvents(events: Pick<LearningEvent, "sessionId" | "primaryConceptId" | "assessment" | "masterySignal">[], sessionId: string): Turn[] {
  return events
    .filter((e) => e.sessionId === sessionId)
    .map((e): Turn => ({
      conceptId: e.primaryConceptId,
      result: (e.assessment ?? "unsettled") as TurnResult,
    }));
}

/**
 * The focus for the question after `current`. `mastery` is what the store holds
 * now, which does not yet include `current` (it is written after the reply),
 * so `current` is folded in here with the same reducer.
 *
 * ponytail: a network retry of the same tool call would count its turn twice.
 * Add the idempotency key to the event type if retries turn out to matter.
 */
export function nextFocusFor(input: {
  concepts: ConceptRef[];
  mastery: Record<string, ConceptMastery>;
  events: Pick<LearningEvent, "sessionId" | "primaryConceptId" | "assessment" | "masterySignal">[];
  sessionId: string;
  current: Turn;
  now: string;
}): NextFocus | null {
  const turns = [...turnsFromEvents(input.events, input.sessionId), input.current];
  const mastery = applyTurn(input.mastery, input.current.conceptId, input.current.result, input.now);
  const next = chooseNext({ concepts: input.concepts, mastery, turns });
  return next ? { concept: next.conceptName, concept_id: next.conceptId, kind: next.kind, reason: next.reason } : null;
}
