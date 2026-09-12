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
  it("teachback gains exceed recognition gains", () => {
    const a = reduceMastery(blankMastery("c", T), { intent: "teachback", createdAt: T, assessment: "correct" });
    const b = reduceMastery(blankMastery("c", T), { intent: "claim", createdAt: T, assessment: "correct" });
    expect(a.delta).toBeGreaterThan(b.delta!);
  });
});
