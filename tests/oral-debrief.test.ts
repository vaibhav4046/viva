import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COURSES } from "@/lib/courses";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import { buildDebrief, debriefToText, resolveConceptId, standingFor, type SessionRecord } from "@/lib/oral/debrief";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "fixtures/sessions/oral-recorded-session.json"), "utf8")) as { record: SessionRecord };
const course = COURSES.course_transformers_w4;
const chunks = course.sources.flatMap((s) => s.chunks);
const NOW = new Date("2026-09-29T19:00:00.000Z");

/** What /api/oral/tool wrote to the store as each verdict came back. */
function masteryAfter(record: SessionRecord): Record<string, ConceptMastery> {
  const out: Record<string, ConceptMastery> = {};
  for (const e of record.entries) {
    if (!e.conceptId) continue;
    const assessment = e.kind === "claim" ? (e.verdict === "supported" ? "correct" : e.verdict === "contradicted" ? "incorrect" : null) : e.grade;
    if (!assessment) continue;
    const prev = out[e.conceptId] ?? blankMastery(e.conceptId, NOW.toISOString());
    out[e.conceptId] = reduceMastery(prev, { intent: "claim", createdAt: NOW.toISOString(), assessment, masterySignal: assessment === "correct" ? "up" : "down" }).next;
  }
  return out;
}

/** The events /api/oral/tool filed: intent claim, the assessment, the concept. */
function eventsOf(record: SessionRecord): LearningEvent[] {
  return record.entries.flatMap((e, i) => {
    const assessment = e.kind === "claim" ? (e.verdict === "supported" ? "correct" : e.verdict === "contradicted" ? "incorrect" : null) : e.grade;
    if (!e.conceptId || !assessment) return [];
    return [{ id: `ev${i}`, intent: "claim", primaryConceptId: e.conceptId, assessment, confusion: assessment === "incorrect" ? 0.8 : 0.1, createdAt: new Date(NOW.getTime() + i * 1000).toISOString() } as unknown as LearningEvent];
  });
}

const debrief = () => buildDebrief({ record: fixture.record, concepts: course.concepts, chunks, mastery: masteryAfter(fixture.record), events: eventsOf(fixture.record), now: NOW });

describe("standing", () => {
  it("is strong with positives only, weak when the last decisive signal is a miss, shaky when a miss was fixed", () => {
    expect(standingFor(["up", "up"])).toBe("strong");
    expect(standingFor(["up", "down"])).toBe("weak");
    expect(standingFor(["down", "up"])).toBe("shaky");
    expect(standingFor(["flat"])).toBe("shaky");
    expect(standingFor([])).toBe("shaky");
  });
});

describe("debrief from a recorded session", () => {
  it("marks each concept from the turn evidence", () => {
    const d = debrief();
    const standing = Object.fromEntries(d.concepts.map((c) => [c.conceptId, c.standing]));
    expect(standing).toMatchObject({
      c_multihead: "weak",
      c_position: "strong",
      c_qkv: "strong",
      c_backprop: "shaky",
      c_policy_value: "shaky",
    });
    expect(d.concepts[0].standing).toBe("weak");
    const mh = d.concepts.find((c) => c.conceptId === "c_multihead")!;
    expect(mh.evidence).toEqual([{ learner: "it runs a single head over the input", result: "the material says otherwise", page: 15 }]);
  });

  it("lists the misconception with the verbatim quote and its page", () => {
    const d = debrief();
    const mh = d.misconceptions.find((m) => m.conceptId === "c_multihead")!;
    expect(mh.material).toEqual({ quote: "Multi-head attention runs the query-key-value computation h times in parallel, each in a smaller subspace.", page: 15 });
    expect(d.misconceptions).toHaveLength(2);
  });

  it("re-verifies citations: a fabricated quote is dropped and the entry no longer counts as a verdict", () => {
    const d = debrief();
    expect(d.citationsDropped).toBe(1);
    const sa = d.concepts.find((c) => c.conceptId === "c_self_attention")!;
    expect(sa.standing).toBe("shaky");
    expect(sa.evidence[0]).toMatchObject({ result: "the material does not settle it", page: null });
  });

  it("builds the plan with the Today planner, in order, within ten minutes, with the weak concept in it", () => {
    const d = debrief();
    expect(d.plan.steps.length).toBeGreaterThan(1);
    expect(d.plan.steps.map((s) => s.order)).toEqual(d.plan.steps.map((_, i) => i + 1));
    expect(d.plan.totalMinutes).toBeLessThanOrEqual(10);
    expect(d.plan.steps.some((s) => s.conceptId === "c_multihead")).toBe(true);
  });

  it("prints the same words, cites the page, and says when storage is ephemeral", () => {
    const d = debrief();
    d.storage = { durable: false, note: "Demo storage resets when the server restarts." };
    const text = debriefToText(d);
    expect(text).toContain("page 15");
    expect(text).toContain("Tomorrow, ");
    expect(text).toContain("Demo storage resets when the server restarts.");
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(text).not.toContain(String.fromCharCode(0x2013));
    expect(text).not.toContain(" ,");
  });

  it("handles a session with no entries without inventing a history", () => {
    const d = buildDebrief({ record: { ...fixture.record, entries: [] }, concepts: course.concepts, chunks, mastery: {}, events: [], now: NOW });
    expect(d.concepts).toEqual([]);
    expect(d.misconceptions).toEqual([]);
    expect(d.plan.steps).toEqual([]);
  });
});

describe("resolveConceptId", () => {
  it("finds a concept by name, alias or the claim text, longest term first", () => {
    expect(resolveConceptId(course.concepts, "multi-head attention")).toBe("c_multihead");
    expect(resolveConceptId(course.concepts, null, "I think positional encoding fixes order")).toBe("c_position");
    expect(resolveConceptId(course.concepts, "nothing relevant")).toBeNull();
  });
});
