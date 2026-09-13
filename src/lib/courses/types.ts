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

/**
 * Where a source came from and what its licence obliges VIVA to say.
 *
 * Openly licensed does not mean unattributed. Every passage VIVA ships that
 * somebody else wrote carries the work's title, its authors, the licence and a
 * link to both the licence and the page the words are on — which is exactly
 * what CC BY asks for, and it is shown to the student rather than buried in a
 * file. A source with no licence recorded is one VIVA wrote or the student
 * gave it, and carries nothing.
 */
export type SourceLicence = {
  /** Short name a person reads: "CC BY 4.0". */
  name: string;
  /** The licence deed. */
  url: string;
  /** Who wrote it, credited as the licence requires. */
  attribution: string;
  /** The exact page these passages were taken from. */
  sourceUrl: string;
  /** The work these passages are an excerpt of. */
  workTitle: string;
  /** ShareAlike: anything built on these passages carries the same licence. */
  shareAlike: boolean;
  /** NonCommercial: these passages may not be used commercially. */
  nonCommercial: boolean;
};

export type CourseSource = {
  id: string;
  title: string;
  type: string;
  chunks: SourceChunk[];
  /** Where the passages were fetched from, when they came off the web. */
  url?: string;
  /** Present on everything VIVA did not write itself. */
  licence?: SourceLicence;
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
  /** true for everything VIVA ships; false for a learner's own subject. */
  demo: boolean;
  /**
   * Who wrote the map for a shipped course. Omitted on the two labs a person
   * wrote by hand; "model" on the library subjects, where a model read the
   * textbook's passages and produced the concepts and questions.
   */
  builtBy?: SubjectBuiltBy | null;
  /**
   * Which model, by name, when `builtBy` is "model".
   *
   * The library is seeded over several runs against whatever credential still
   * has budget that day, so one file can hold maps written by two different
   * models. A single name at the top of `library.json` would then be wrong
   * about most of it, and "a model wrote this" is a claim the app makes to the
   * student — the name of the one that did belongs with the subject it wrote,
   * not with the file.
   */
  builtByModel?: string;
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

/**
 * How a subject came to exist. `starter` is one VIVA ships — either a lab
 * written for this project or a chapter of an openly licensed textbook;
 * `url` is a page the student pointed VIVA at; `file` is a text, markdown or
 * Word document they uploaded.
 */
export type SubjectOrigin = "starter" | "paste" | "pdf" | "named" | "url" | "file";

/**
 * Who did the reading. `model` = a language model read the text and wrote the
 * map; `reading` = VIVA pulled the concepts out of the text itself. The
 * difference is visible to the student, in plain words, on every subject card.
 */
export type SubjectBuiltBy = "model" | "reading";

/**
 * A subject is a course that may belong to one student.
 * `demo: true` marks everything VIVA ships; everything else is theirs.
 */
export type Subject = Course & {
  ownerId: string;
  createdAt: string;
  origin: SubjectOrigin;
  /** null for the labs a person wrote; set on everything else. */
  builtBy: SubjectBuiltBy | null;
  /** Recognition bias for the dictation call (≤100 terms). */
  keyterms: string[];
  languageCodes: string[];
};
