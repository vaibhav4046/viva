import { describe, expect, it } from "vitest";
import { bandLabelFor, blankMastery, reduceMastery } from "@/lib/mastery";

const T = "2026-09-13T10:00:00.000Z";

type Signal = {
  assessment?: "correct" | "partial" | "incorrect" | null;
  masterySignal?: "up" | "down" | "flat" | null;
};

/** One study turn on a concept nobody has touched yet. */
function oneTurn(event: Signal) {
  return reduceMastery(blankMastery("c_multihead", T), { intent: "claim", createdAt: T, ...event });
}

/*
 * A judge said three things about one subject — one right, one flatly wrong,
 * one VIVA could not check — and the map read "Shaky" with 0 got and 0 missed
 * for all three. These are the rules that stop that: what may move a counter,
 * what may only move the number, and what may move nothing at all.
 */
describe("study-turn signals move the record", () => {
  it("a source-checked correct sentence is a got-it and leaves Shaky", () => {
    const r = oneTurn({ assessment: "correct", masterySignal: "up" });
    expect(r.next.successfulRecallCount).toBe(1);
    expect(r.next.failedRecallCount).toBe(0);
    expect(r.next.lastSuccessfulRecallAt).toBe(T);
    expect(bandLabelFor(r.next)).toBe("Getting there");
  });

  it("a source-checked wrong sentence is a missed-it and reads Mixed up", () => {
    const r = oneTurn({ assessment: "incorrect" });
    expect(r.next.failedRecallCount).toBe(1);
    expect(r.next.successfulRecallCount).toBe(0);
    expect(r.next.misconceptionCount).toBe(1);
    expect(bandLabelFor(r.next)).toBe("Mixed up");
  });

  it("a down signal is a missed-it too — being found wrong is being found wrong", () => {
    const r = oneTurn({ masterySignal: "down" });
    expect(r.next.failedRecallCount).toBe(1);
    expect(r.next.successfulRecallCount).toBe(0);
    // Weaker evidence than a graded answer: no misconception, smaller move.
    expect(r.next.misconceptionCount).toBe(0);
    expect(r.delta).toBeGreaterThan(oneTurn({ assessment: "incorrect" }).delta!);
  });

  it("an up signal is NOT a got-it — a model liking the sound of it verifies nothing", () => {
    const r = oneTurn({ masterySignal: "up" });
    expect(r.next.successfulRecallCount).toBe(0);
    expect(r.next.lastSuccessfulRecallAt).toBeNull();
    // It may still nudge the number, by less than a checked answer does.
    expect(r.delta).toBeGreaterThan(0);
    expect(r.delta!).toBeLessThan(oneTurn({ assessment: "correct" }).delta!);
  });

  it("a sentence VIVA could not check moves no counter and no number", () => {
    const r = oneTurn({ masterySignal: "flat" });
    expect(r.next.successfulRecallCount).toBe(0);
    expect(r.next.failedRecallCount).toBe(0);
    expect(r.delta).toBe(0);
    expect(bandLabelFor(r.next)).toBe("Shaky");
  });

  it("right, wrong and unverifiable produce three different records", () => {
    const rows = [
      oneTurn({ assessment: "correct", masterySignal: "up" }),
      oneTurn({ assessment: "incorrect" }),
      oneTurn({ masterySignal: "flat" }),
    ].map((r) => [bandLabelFor(r.next), r.next.successfulRecallCount, r.next.failedRecallCount].join("/"));
    expect(new Set(rows).size).toBe(3);
    expect(rows).toEqual(["Getting there/1/0", "Mixed up/0/1", "Shaky/0/0"]);
  });

  it("saying you are confused is Shaky, not Mixed up", () => {
    // The band floor sits between the two moves that land near it, so an
    // admission of not following stays clear of "you have this backwards".
    const r = reduceMastery(blankMastery("c_confused", T), { intent: "confusion", createdAt: T });
    expect(bandLabelFor(r.next)).toBe("Shaky");
    expect(r.next.failedRecallCount).toBe(0);
  });
});
