import { describe, expect, it } from "vitest";
import { CORPUS, corpusLicences } from "@/lib/corpus";
import { COURSES } from "@/lib/courses";
import { listSubjectsFor, starterSubject, subjectMeta } from "@/lib/courses/subject";
import { retrieveEvidence } from "@/lib/retrieval";
import { FileEventStore } from "@/lib/store/file";

/**
 * The preloaded library.
 *
 * Two things are load-bearing here and neither is negotiable. The licence:
 * these passages are somebody else's writing, used under CC BY, and the
 * attribution has to travel with them all the way to the screen. And the
 * grounding: a subject in this library has to answer out of its OWN passages,
 * because every citation the tutor makes resolves to a stored chunk id.
 */

describe("preloaded library", () => {
  it("ships a library a student would recognise", () => {
    // Vacuous passes are the failure mode for a data-driven suite: an empty
    // library would satisfy every `for` loop below.
    expect(CORPUS.length).toBeGreaterThanOrEqual(8);
    const subjects = new Set(CORPUS.map((c) => c.subject.toLowerCase()));
    expect(subjects.size).toBeGreaterThanOrEqual(8);
  });

  it("every seeded source carries the licence it was taken under", () => {
    for (const course of CORPUS) {
      expect(course.sources.length).toBeGreaterThan(0);
      for (const source of course.sources) {
        const licence = source.licence;
        expect(licence, `${course.id} has a source with no licence`).toBeTruthy();
        if (!licence) continue;
        expect(licence.name).toBe("CC BY 4.0");
        expect(licence.url).toMatch(/^https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
        expect(licence.attribution.length).toBeGreaterThan(10);
        expect(licence.sourceUrl).toMatch(/^https:\/\//);
        expect(licence.workTitle.length).toBeGreaterThan(2);
        // The seeder refuses NC and SA books; if one ever lands here, the terms
        // shown to the student would be the wrong ones.
        expect(licence.nonCommercial).toBe(false);
        expect(licence.shareAlike).toBe(false);
      }
    }
  });

  it("says a model wrote the map, because one did", () => {
    for (const course of CORPUS) expect(course.builtBy).toBe("model");
    const meta = subjectMeta(starterSubject(CORPUS[0]));
    expect(meta.builtBy).toBe("model");
    expect(meta.attribution.length).toBeGreaterThan(0);
    expect(meta.attribution[0].name).toBe("CC BY 4.0");
  });

  it("hand-written labs carry no attribution and claim no author", () => {
    const transformers = subjectMeta(starterSubject(COURSES["course_transformers_w4"]));
    expect(transformers.attribution).toEqual([]);
    expect(transformers.builtBy).toBeNull();
  });

  it("has enough passages per subject for retrieval to have somewhere to go", () => {
    for (const course of CORPUS) {
      const chunks = course.sources.flatMap((s) => s.chunks);
      expect(chunks.length, `${course.id} has ${chunks.length} passages`).toBeGreaterThanOrEqual(10);
      expect(course.concepts.length).toBeGreaterThanOrEqual(6);
      expect(course.examQuestions.length).toBeGreaterThanOrEqual(5);
      // Every passage says which part of the book it is from.
      for (const chunk of chunks) expect((chunk.locator.section ?? "").length).toBeGreaterThan(0);
    }
  });

  it("concept ids are unique across everything VIVA ships", () => {
    // ownerCourse() and findSubjectOwning() answer "which subject owns this
    // concept" by scanning every course and taking the first hit. Two subjects
    // sharing an id means one of them silently grades against the other.
    const seen = new Map<string, string>();
    for (const course of Object.values(COURSES)) {
      for (const concept of course.concepts) {
        expect(seen.has(concept.id), `${concept.id} is in both ${seen.get(concept.id)} and ${course.id}`).toBe(false);
        seen.set(concept.id, course.id);
      }
    }
  });

  it("chunk ids are unique across everything VIVA ships", () => {
    const ids = Object.values(COURSES).flatMap((c) => c.sources.flatMap((s) => s.chunks.map((x) => x.id)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("retrieval on a library subject returns that subject's own passages", () => {
    for (const course of CORPUS) {
      const chunks = course.sources.flatMap((s) => s.chunks);
      const own = new Set(chunks.map((c) => c.id));
      const query = course.examQuestions[0].question;
      const hits = retrieveEvidence(query, { chunks, limit: 3 });
      expect(hits.length, `${course.id} retrieved nothing for its own first question`).toBeGreaterThan(0);
      for (const hit of hits) expect(own.has(hit.chunk.id)).toBe(true);
    }
  });

  it("the library is listed to a learner alongside the labs", async () => {
    const store = new FileEventStore();
    const user = `u_corpus_${Date.now()}`;
    try {
      const listed = await listSubjectsFor(store, user);
      for (const course of CORPUS) {
        const found = listed.find((s) => s.id === course.id);
        expect(found, `${course.id} is not listed`).toBeTruthy();
        expect(found?.attribution.length).toBeGreaterThan(0);
      }
    } finally {
      await store.deleteUserData(user);
    }
  });

  it("one attribution list covers the whole library", () => {
    const licences = corpusLicences();
    expect(licences.length).toBeGreaterThan(0);
    for (const l of licences) expect(l.attribution).toMatch(/Access for free at https:\/\//);
  });
});
