/**
 * Client-side mirror of GET /api/learner/path.
 * The route owns the truth; this file only types the wire shape.
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

export type DailyPath = {
  path: PathSegment[];
  generatedAt: string;
  basis: { events: number; concepts: number };
};

/** Client-side mirror of GET /api/learner/week ("Your week"). */
export type WeekSegment = { conceptId: string; title: string; reason: string };

export type WeekDay = { date: string; label: string; segments: WeekSegment[]; count: number };

export type WeeklyProjection = { days: WeekDay[]; generatedAt: string };

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

/** Locale-free date/time slices — identical on server and client. */
export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortTimeUtc(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}
