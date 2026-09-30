/**
 * The labelled sample course: "Transformers, Week 4", VIVA's own course notes.
 * "Try a sample exam" selects it and opens /oral. The two storage keys are the
 * ones the study pages (viva_course) and the oral screen (viva.courseId) read,
 * and the subject id also rides in the URL so a bookmark lands on the same exam.
 */
export const SAMPLE_COURSE_ID = "course_transformers_w4";
const STUDY_KEY = "viva_course";
const ORAL_KEY = "viva.courseId";

/** Store the sample selection and return the URL to open. Storage may be blocked; the URL still works. */
export function selectSampleCourse(): string {
  try {
    window.localStorage.setItem(STUDY_KEY, SAMPLE_COURSE_ID);
    window.localStorage.setItem(ORAL_KEY, SAMPLE_COURSE_ID);
  } catch {
    /* private mode: the URL parameter carries the selection */
  }
  return `/oral?subjectId=${encodeURIComponent(SAMPLE_COURSE_ID)}`;
}
