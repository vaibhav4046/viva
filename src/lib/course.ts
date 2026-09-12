import type { SourceChunk } from "./types";
import type { ConceptDef, ExamQuestion } from "./courses/types";
import { TRANSFORMERS } from "./courses/transformers";

/**
 * Compatibility shim — the Transformers lab now lives in the course registry
 * (src/lib/courses). These exports keep existing imports/tests working.
 * New code should use getCourse()/listCourses() from "@/lib/courses".
 */

const SOURCE = TRANSFORMERS.sources[0];

export const DEMO_COURSE = {
  id: TRANSFORMERS.id,
  title: TRANSFORMERS.title,
  code: TRANSFORMERS.code,
  subject: TRANSFORMERS.subject,
} as const;

export const DEMO_SOURCE = {
  id: SOURCE.id,
  courseId: TRANSFORMERS.id,
  title: SOURCE.title,
  type: SOURCE.type,
} as const;

export type { ConceptDef };

export const CONCEPTS: ConceptDef[] = TRANSFORMERS.concepts;

export const SOURCE_CHUNKS: SourceChunk[] = TRANSFORMERS.sources.flatMap((s) => s.chunks);

export const EXAM_QUESTIONS: ExamQuestion[] = TRANSFORMERS.examQuestions;
