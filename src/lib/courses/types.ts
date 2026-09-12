import type { ConceptMastery, SourceChunk } from "@/lib/types";

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
  /** true for the two starters we ship; false for a learner's own subject. */
  demo: boolean;
  sources: CourseSource[];
  concepts: ConceptDef[];
  examQuestions: ExamQuestion[];
  teachback: {
    keywords: Record<string, string[]>;
    hints: Record<string, string>;
  };
  explainers: Record<string, Explainer>;
  traps: Trap[];
  /**
   * Opening map for a starter: where its concepts begin before the student
   * has said anything. Lives with the course it describes, so no generic code
   * has to know one subject's concept ids. `recalled` stands in for
   * `lastSuccessfulRecallAt`, which each store stamps with its own clock.
   */
  priors?: Record<string, Partial<Omit<ConceptMastery, "lastSuccessfulRecallAt">> & { recalled?: boolean }>;
  /**
   * The one already-remembered sentence a starter opens with, so history is
   * never empty on the first visit. Starter content, labelled as such.
   */
  opening?: { conceptId: string; chunkId: string; text: string };
};

/** How a subject came to exist. `starter` is one we wrote and ship. */
export type SubjectOrigin = "starter" | "paste" | "pdf" | "named";

/**
 * Who did the reading. `model` = a language model read the text and wrote the
 * map; `reading` = VIVA pulled the concepts out of the text itself. The
 * difference is visible to the student, in plain words, on every subject card.
 */
export type SubjectBuiltBy = "model" | "reading";

/**
 * A subject is a course that may belong to one student.
 * `demo: true` marks the two starters we ship; everything else is theirs.
 */
export type Subject = Course & {
  ownerId: string;
  createdAt: string;
  origin: SubjectOrigin;
  /** null for the starters — a person wrote those. */
  builtBy: SubjectBuiltBy | null;
  /** Recognition bias for the dictation call (≤100 terms). */
  keyterms: string[];
  languageCodes: string[];
};
