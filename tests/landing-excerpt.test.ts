import { describe, expect, it } from "vitest";
import { EXCERPT } from "@/lib/fixtures/excerpt";
import { SAMPLE_COURSE_ID } from "@/lib/sample-course";
import { getCourse } from "@/lib/courses";

/*
 * The landing excerpt claims to quote a page of the sample course. If the course
 * text changes, or the quote drifts, the landing would show a quotation the
 * verifier would reject. These tests keep the fixture honest.
 */
describe("landing excerpt fixture", () => {
  const course = getCourse(SAMPLE_COURSE_ID);
  const chunk = course.sources.flatMap((s) => s.chunks).find((c) => c.id === EXCERPT.passage.passageId);

  it("points at a real passage of the sample course", () => {
    expect(chunk).toBeDefined();
    expect(chunk?.locator.page).toBe(EXCERPT.passage.page);
  });

  it("quotes the passage verbatim", () => {
    const { before, match, after } = EXCERPT.passage;
    expect(chunk?.text).toContain(match);
    expect(chunk?.text.startsWith(before + match + after)).toBe(true);
  });

  it("marks a phrase that is actually in the learner line", () => {
    expect(EXCERPT.learnerAnswer).toContain(EXCERPT.learnerWrong);
  });
});
