import type { LearningEvent } from "@/lib/types";

/**
 * Memory-surface signal helpers. The misconception predicate mirrors the
 * canonical one in src/lib/planner.ts (used by path + week) exactly:
 *  - `assessment: "incorrect"` when the backend persists it (blob/pg), or
 *  - intent claim/teachback with confusion 0.6 — how exam/teachback routes
 *    record a failed attempt (file backend drops the assessment field).
 */
export type EventWithAssessment = LearningEvent & {
  assessment?: "correct" | "partial" | "incorrect" | null;
};

export function isMisconceptionEvent(e: EventWithAssessment): boolean {
  if (e.assessment === "incorrect") return true;
  return (e.intent === "claim" || e.intent === "teachback") && e.confusion >= 0.6;
}

/** A concept's events, oldest first — the replay's only source of truth. */
export function conceptEvents(events: LearningEvent[], conceptId: string): EventWithAssessment[] {
  return events
    .filter((e) => e.primaryConceptId === conceptId)
    .map((e) => e as EventWithAssessment)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export const INTENT_LABEL: Record<string, string> = {
  confusion: "CONFUSION",
  remember: "REMEMBER",
  exam_marker: "EXAM MARK",
  claim: "CLAIM",
  teachback: "TEACHBACK",
  quiz_request: "RECALL REQUEST",
  explain: "EXPLAIN",
  question: "QUESTION",
  compare: "COMPARE",
  review_request: "REVIEW REQUEST",
  connection: "CONNECTION",
  correction: "CORRECTION",
  note: "NOTE",
};

export function intentLabel(intent: string): string {
  return INTENT_LABEL[intent] ?? intent.toUpperCase();
}
