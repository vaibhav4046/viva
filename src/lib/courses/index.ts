import type { Course } from "./types";
import { TRANSFORMERS } from "./transformers";
import { PROBABILITY } from "./probability";

export type { Course, ConceptDef, ExamQuestion, Explainer, Trap, CourseSource } from "./types";

/** First-class labs, keyed by course id. Add new labs here only. */
export const COURSES: Record<string, Course> = {
  [TRANSFORMERS.id]: TRANSFORMERS,
  [PROBABILITY.id]: PROBABILITY,
};

export const DEFAULT_COURSE_ID = "course_transformers_w4";

/** Resolve a course by id; unknown or missing ids fall back to the default. */
export function getCourse(idOrNull?: string | null): Course {
  if (idOrNull && COURSES[idOrNull]) return COURSES[idOrNull];
  return COURSES[DEFAULT_COURSE_ID];
}

/** Lightweight list for pickers/navigation (no chunk bodies). */
export function listCourses(): { id: string; code: string; title: string; subject: string; demo: boolean }[] {
  return Object.values(COURSES).map((c) => ({
    id: c.id,
    code: c.code,
    title: c.title,
    subject: c.subject,
    demo: c.demo,
  }));
}
