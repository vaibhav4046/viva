import { describe, expect, it } from "vitest";
import { blankMastery, reduceMastery } from "@/lib/mastery";

const T = "2026-09-09T10:00:00.000Z";

describe("learner reducer", () => {
  it("confusion → failed recall → correction moves down then up", () => {
    let m = blankMastery("c_position", T);
    const start = m.mastery;
    m = reduceMastery(m, { intent: "confusion", createdAt: T }).next;
    expect(m.mastery).toBeLessThan(start);
    m = reduceMastery(m, { intent: "claim", createdAt: T, assessment: "incorrect" }).next;
    const low = m.mastery;
    m = reduceMastery(m, { intent: "claim", createdAt: T, assessment: "correct" }).next;
    expect(m.mastery).toBeGreaterThan(low);
  });
  it("bounds mastery in [0,1] and tracks reasons", () => {
    let m = blankMastery("c_x", T);
    for (let i = 0; i < 30; i++) m = reduceMastery(m, { intent: "claim", createdAt: T, assessment: "incorrect" }).next;
    expect(m.mastery).toBeGreaterThanOrEqual(0);
    expect(m.reviewPriority).toBeGreaterThan(0.5);
  });
  /*
   * The tutor emits a direction, never a number, and these two branches are
   * where the direction becomes one. `masterySignal` appeared nowhere in this
   * file, so both branches could be deleted with the suite still green.
   */
  it("an unverified-but-right-sounding claim moves up, a little", () => {
    const r = reduceMastery(blankMastery("c_up", T), { intent: "claim", createdAt: T, masterySignal: "up" });
    expect(r.delta).toBeGreaterThan(0);
    expect(r.reason).toMatch(/not yet checked/i);
    // Smaller than a graded correct answer: a signal is not a verdict.
    const graded = reduceMastery(blankMastery("c_up", T), { intent: "claim", createdAt: T, assessment: "correct" });
    expect(r.delta!).toBeLessThan(graded.delta!);
  });
  it("a claim that did not match the source moves down", () => {
    const r = reduceMastery(blankMastery("c_down", T), { intent: "claim", createdAt: T, masterySignal: "down" });
    expect(r.delta).toBeLessThan(0);
    expect(r.reason).toMatch(/did not match/i);
    // And costs less than a graded wrong answer, which also logs a misconception.
    const graded = reduceMastery(blankMastery("c_down", T), { intent: "claim", createdAt: T, assessment: "incorrect" });
    expect(r.delta!).toBeGreaterThan(graded.delta!);
    expect(r.next.misconceptionCount).toBe(0);
  });
  it("a claim VIVA could not check costs the learner nothing", () => {
    const before = blankMastery("c_flat_signal", T);
    const r = reduceMastery(before, { intent: "claim", createdAt: T, masterySignal: "flat" });
    expect(r.delta).toBe(0);
    expect(r.next.mastery).toBe(before.mastery);
    expect(r.next.misconceptionCount).toBe(0);
    // Still counts as having been seen, so the band stops saying "Not yet".
    expect(r.next.exposureCount).toBe(before.exposureCount + 1);
  });

  it("no verdict and no signal is a smaller move than either signal", () => {
    const flat = reduceMastery(blankMastery("c_flat", T), { intent: "claim", createdAt: T });
    expect(flat.delta).toBeLessThan(0);
    expect(flat.reason).toMatch(/unverified/i);
  });

  it("teachback gains exceed recognition gains", () => {
    const a = reduceMastery(blankMastery("c", T), { intent: "teachback", createdAt: T, assessment: "correct" });
    const b = reduceMastery(blankMastery("c", T), { intent: "claim", createdAt: T, assessment: "correct" });
    expect(a.delta).toBeGreaterThan(b.delta!);
  });
});
