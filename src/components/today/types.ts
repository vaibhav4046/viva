/**
 * Prop shape for one Daily Path step. The plan itself is folded on the page
 * from the learner snapshot (see ./snapshot.ts) with the planner in
 * src/lib/planner.ts, which owns the composition rules.
 */
export type PathSegment = {
  kind: "recall" | "weak_concept" | "misconception" | "teachback" | "summary";
  conceptId: string | null;
  conceptName?: string;
  /** Owning lab when known — lets "All courses" mode hand off to the right API. */
  courseId?: string | null;
  minutes: number;
  why: string;
  action: "inline_recall" | "study" | "teachback" | "capture";
};

export type ExamQuestion = { id: string; question: string; conceptId?: string; courseId?: string };

export type ExamAnswerResponse = {
  verdict: "correct" | "partial" | "incorrect";
  feedback: string;
  correctPoints?: string[];
  missingPoints?: string[];
  possibleMisconception?: string | null;
  delta?: number | null;
  reason?: string | null;
  evidenceIds?: string[];
};

/** Locale-free date slice — identical on server and client. */
export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
