import type { SourceChunk } from "@/lib/types";

/** A teachable concept within a course (compiler target + mastery unit). */
export type ConceptDef = {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  related: string[];
};

export type ExamQuestion = {
  id: string;
  conceptId: string;
  question: string;
  requiredKeywords: string[];
  hint: string;
};

export type Explainer = {
  /** Formal, source-grounded explanation. */
  formal: string;
  /** Plain-language analogy explanation. */
  jargonFree: string;
  /** What the learner still needs to hear after this explanation. */
  missing: string[];
};

export type Trap = {
  id: string;
  conceptId: string;
  statement: string;
  whyWrong: string;
  correct: string;
};

export type CourseSource = {
  id: string;
  title: string;
  type: string;
  chunks: SourceChunk[];
};

/**
 * A first-class lab: original VIVA-authored course notes bundled with the app.
 * Every citation the tutor makes resolves to one of `sources[].chunks`.
 */
export type Course = {
  id: string;
  code: string;
  title: string;
  subject: string;
  demo: true;
  sources: CourseSource[];
  concepts: ConceptDef[];
  examQuestions: ExamQuestion[];
  teachback: {
    keywords: Record<string, string[]>;
    hints: Record<string, string>;
  };
  explainers: Record<string, Explainer>;
  traps: Trap[];
};
