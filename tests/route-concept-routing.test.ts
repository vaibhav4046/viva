import { describe, expect, it } from "vitest";
import { compileTranscript } from "@/lib/compiler";
import { COURSES, getCourse, type Course } from "@/lib/courses";
import { CORPUS } from "@/lib/corpus";

/**
 * Which concept a turn is filed against.
 *
 * A student judge pasted two passages off the /study screen word for word.
 * The tutor refused to credit either of them — correctly — and both were
 * still filed against Self-attention, a concept they never mentioned, because
 * the router ranked concepts by the longest single alias that appeared
 * anywhere in the text and "attention" is longer than "query". Their map then
 * said they had got Self-attention right twice, and /today told them to spend
 * less time on it.
 */

const TRANSFORMERS = getCourse("course_transformers_w4");

/** Passage 3 of Transformers · Week 4, as the judge typed it back. */
const QKV_PASTE =
  "Each token is projected into three vectors: a query (what this token is looking for), " +
  "a key (what this token offers to others), and a value (the content carried forward). " +
  "The attention score between token i and token j is the dot product of query i and key j, " +
  "scaled by the square root of the key dimension.";

function primary(text: string, course = TRANSFORMERS): string | null {
  return compileTranscript(text, { concepts: course.concepts, courseId: course.id }).primaryConceptId;
}

describe("a turn is filed against the concept it is mostly about", () => {
  it("routes the queries/keys/values passage to Queries, Keys, Values — not Self-attention", () => {
    // "query", "key" and "value" between them cover six mentions; "attention"
    // covers one, and used to win on being nine characters long.
    expect(primary(QKV_PASTE)).toBe("c_qkv");
  });

  it("still lets one long mention beat one short one", () => {
    // The rule this replaced existed for a reason and the reason still holds.
    expect(primary("Positional encoding is what attention lacks.")).toBe("c_position");
  });

  it("does not let a broad concept take a narrow one's own sentence", () => {
    // "Semantic encoding" contains "encoding": counting bare occurrences files
    // this under the parent concept, which is how plain frequency loses 37 rows.
    const psych = COURSES["course_os_psych"];
    if (psych) {
      expect(primary("Semantic encoding is the encoding of words and their meanings.", psych))
        .toBe("psych_semantic_encoding");
    }
  });
});

/**
 * The library-wide ratchet.
 *
 * Every text in every shipped subject that carries a concept id of its own is
 * a routing case with a known answer. 393 of 856 landed on the labelled
 * concept before this change and 407 after; the floor sits between the two, so
 * a re-rank that fixes one passage by misfiling ten cannot land quietly. It is
 * a floor and not an equality because the preloaded library is generated
 * (`scripts/seed-corpus.mjs`) and the row count moves when it is re-seeded.
 */
describe("routing accuracy across every subject VIVA ships", () => {
  it("files at least 400 of its own labelled texts under the right concept", () => {
    const seen = new Set<string>();
    let rows = 0;
    let right = 0;
    for (const course of [...Object.values(COURSES), ...CORPUS] as Course[]) {
      if (seen.has(course.id)) continue;
      seen.add(course.id);
      const cases: { label: string; text: string }[] = [
        ...course.examQuestions.map((q) => ({ label: q.conceptId, text: q.question })),
        ...course.traps.flatMap((t) => [
          { label: t.conceptId, text: t.statement },
          { label: t.conceptId, text: t.correct },
        ]),
        ...Object.entries(course.explainers ?? {}).flatMap(([id, e]) => [
          { label: id, text: e.formal },
          { label: id, text: e.jargonFree },
        ]),
        ...course.concepts.map((c) => ({ label: c.id, text: c.description })),
      ];
      for (const c of cases) {
        rows += 1;
        if (primary(c.text, course) === c.label) right += 1;
      }
    }
    expect(rows).toBeGreaterThan(800);
    expect(right, `${right}/${rows} routed to the labelled concept`).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
