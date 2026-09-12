import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileTranscript } from "@/lib/compiler";
import { retrieveEvidence } from "@/lib/retrieval";
import { COURSES, DEFAULT_COURSE_ID, getCourse, listCourses } from "@/lib/courses";
import { tutorRespond } from "@/lib/tutor";
import { FileEventStore } from "@/lib/store/file";

const PROB = getCourse("course_probability");

describe("multi-course generalization", () => {
  it("compiler routes base-rate neglect to the probability concept", () => {
    const d = compileTranscript("I don't understand base-rate neglect", { courseId: "course_probability" });
    expect(d.primaryConceptId).toBe("c_baserate");
  });

  it("default compiler behavior is unchanged for Transformers", () => {
    const d = compileTranscript("I don't understand positional encoding");
    expect(d.primaryConceptId).toBe("c_position");
  });

  it("retrieval uses probability chunks when the course chunks are passed", () => {
    const chunks = PROB.sources.flatMap((s) => s.chunks);
    const r = retrieveEvidence("How does Bayes theorem update the prior into a posterior using the likelihood?", { chunks, limit: 3 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].chunk.id).toMatch(/^ch_pr_bayes/);
  });

  it("tutor explains from the probability course's own explainers", () => {
    const t = tutorRespond({
      intent: "confusion",
      cleanedTranscript: "I don't understand conditional probability",
      conceptName: "Conditional probability",
      conceptId: "c_cond",
      evidenceIds: ["ch_pr_cond_1"],
      courseId: "course_probability",
    });
    expect(t.strategy).toBe("socratic");
    expect(t.text).toMatch(/sample space|renormalis/i);
  });

  it("core libraries contain no Transformers-specific literals", () => {
    for (const f of ["compiler.ts", "mastery.ts", "retrieval.ts"]) {
      const src = readFileSync(path.join(process.cwd(), "src", "lib", f), "utf-8");
      expect(src.includes('includes("positional")')).toBe(false);
      expect(src.includes('"c_position"')).toBe(false);
      expect(src.includes("c_position")).toBe(false);
    }
  });

  it("registry falls back to the default course and lists both labs", () => {
    expect(getCourse("nonsense").id).toBe(DEFAULT_COURSE_ID);
    expect(getCourse(null).id).toBe(DEFAULT_COURSE_ID);
    expect(listCourses().length).toBeGreaterThanOrEqual(2);
    expect(listCourses().map((c) => c.id)).toContain("course_probability");
  });

  it("every course is internally consistent", () => {
    for (const course of Object.values(COURSES)) {
      const conceptIds = new Set(course.concepts.map((c) => c.id));
      for (const q of course.examQuestions) {
        expect(conceptIds.has(q.conceptId)).toBe(true);
        expect(q.requiredKeywords.length).toBeGreaterThan(0);
        expect(q.hint.length).toBeGreaterThan(0);
      }
      for (const t of course.traps) {
        expect(conceptIds.has(t.conceptId)).toBe(true);
        expect(t.whyWrong.length).toBeGreaterThan(0);
        expect(t.correct.length).toBeGreaterThan(0);
      }
      const ids = course.sources.flatMap((s) => s.chunks.map((c) => c.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("teachback keywords and hints exist for every concept in every course", () => {
    for (const course of Object.values(COURSES)) {
      for (const concept of course.concepts) {
        expect((course.teachback.keywords[concept.id] ?? []).length).toBeGreaterThanOrEqual(3);
        expect((course.teachback.hints[concept.id] ?? "").length).toBeGreaterThan(0);
        expect((course.explainers[concept.id]?.formal ?? "").length).toBeGreaterThan(0);
        expect((course.explainers[concept.id]?.jargonFree ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("file store scopes chunks, concepts and uploads per course", async () => {
    const s = new FileEventStore();
    const u = `u_courses_${Date.now()}`;
    try {
      await s.seedCourse(u, "course_probability");
      const probChunks = await s.getCourseChunks(u, "course_probability");
      expect(probChunks.some((c) => c.id === "ch_pr_bayes_1")).toBe(true);
      expect(probChunks.some((c) => c.id === "ch_pos_1")).toBe(false);
      const probConcepts = await s.getConcepts(u, "course_probability");
      expect(probConcepts.map((c) => c.id)).toContain("c_baserate");
      expect(probConcepts.map((c) => c.id)).not.toContain("c_position");
      // The default course stays available and unaffected.
      expect((await s.getCourseChunks(u)).some((c) => c.id === "ch_pos_1")).toBe(true);
      const hits = await s.retrieveEvidence(u, "Bayes theorem prior likelihood posterior", { courseId: "course_probability" });
      expect(hits[0]?.chunk.id).toMatch(/^ch_pr_bayes/);
      // Uploads attach to the course they were added under.
      await s.addSource(u, { title: "My notes", type: "pdf", chunks: [{ text: "probability upload marker", section: "S" }], courseId: "course_probability" });
      expect((await s.getCourseChunks(u, "course_probability")).some((c) => c.text.includes("probability upload marker"))).toBe(true);
      expect((await s.getCourseChunks(u)).some((c) => c.text.includes("probability upload marker"))).toBe(false);
    } finally {
      await s.deleteUserData(u);
    }
  });
});
