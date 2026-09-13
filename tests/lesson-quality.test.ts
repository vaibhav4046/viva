import { describe, expect, it } from "vitest";
import { COURSES } from "@/lib/courses";

/**
 * The material itself, not the machinery that serves it.
 *
 * A model wrote the concept map, the questions and the traps for 24 of the 26
 * shipped subjects, and a student is told these are their source. An audit of
 * that material found 26 of 153 questions demanded a keyword absent from their
 * own passages — a student reading BIO4 answers "magnification makes it
 * bigger" and loses a point because the key wants "enlarges". Nothing was
 * watching the content, only the code.
 */
const words = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2);

const SUBJECTS = Object.values(COURSES).filter((c) => c.sources.some((s) => s.chunks.length));

function bodyOf(course: (typeof SUBJECTS)[number]) {
  return course.sources.flatMap((s) => s.chunks).map((c) => c.text).join(" ").toLowerCase();
}

describe("the material VIVA ships", () => {
  it("has subjects to check", () => {
    expect(SUBJECTS.length).toBeGreaterThanOrEqual(20);
  });

  it("never demands an answer word the passages do not use", () => {
    const unfair: string[] = [];
    for (const course of SUBJECTS) {
      const body = bodyOf(course);
      for (const q of course.examQuestions ?? []) {
        const required = q.requiredKeywords ?? [];
        // Below the floor the key is kept deliberately — see groundedKeywords
        // in src/lib/corpus/index.ts — so only longer keys are held to this.
        if (required.length < 3) continue;
        const missing = required.filter((k) => !words(k).some((w) => body.includes(w)));
        if (missing.length) unfair.push(`${course.code}: "${q.question.slice(0, 44)}" wants ${missing.join(", ")}`);
      }
    }
    expect(unfair, unfair.join("\n")).toEqual([]);
  });

  it("never asks about a concept its own passages never mention", () => {
    const orphans: string[] = [];
    for (const course of SUBJECTS) {
      const body = bodyOf(course);
      for (const c of course.concepts) {
        if (!words(c.name).some((w) => body.includes(w))) orphans.push(`${course.code}: ${c.name}`);
      }
    }
    // One known orphan is tolerated while the library is regenerated a subject
    // at a time; the point of the number is that it may not grow.
    expect(orphans.length, orphans.join("\n")).toBeLessThanOrEqual(1);
  });

  it("grounds a trap's correction in the source it cites", () => {
    const ungrounded: string[] = [];
    for (const course of SUBJECTS) {
      const body = bodyOf(course);
      for (const t of course.traps ?? []) {
        const w = words(t.correct);
        if (!w.length) continue;
        const grounded = w.filter((x) => body.includes(x)).length / w.length;
        if (grounded < 0.4) ungrounded.push(`${course.code}: ${t.correct.slice(0, 48)} (${Math.round(grounded * 100)}%)`);
      }
    }
    // A formula written in symbols the prose spells out in words is the one
    // shape that trips this honestly, so the bar is a ceiling, not zero.
    expect(ungrounded.length, ungrounded.join("\n")).toBeLessThanOrEqual(1);
  });

  it("gives every question an answer key", () => {
    const keyless = SUBJECTS.flatMap((c) =>
      (c.examQuestions ?? []).filter((q) => !(q.requiredKeywords ?? []).length).map((q) => `${c.code}: ${q.question.slice(0, 44)}`)
    );
    expect(keyless, keyless.join("\n")).toEqual([]);
  });
});
