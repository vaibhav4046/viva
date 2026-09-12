import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FileEventStore } from "@/lib/store/file";
import { WEEK_DAYS, projectWeek, type PlannerInput } from "@/lib/planner";
import { blankMastery } from "@/lib/mastery";
import type { LearningEvent } from "@/lib/types";
import { GET as weekGet } from "@/app/api/learner/week/route";

/**
 * 7-day review projection ("Your week").
 * Covers: deterministic output for a seeded store, due-date escalation per the
 * spacing rule (queue dueAt + one-candidate-per-day ladder spread), empty state,
 * and the route wire shape with a fixed identity.
 */

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return {
    ...actual,
    resolveIdentity: async () => ({ identity: { userId: "demo_week_route", kind: "demo" as const } }),
  };
});

const FIXED_NOW = new Date("2026-09-11T09:00:00.000Z");
const DAY_MS = 24 * 3600 * 1000;

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-week-"));
  process.env.DATA_DIR = tmp;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

function atNow(days: number): string {
  return new Date(FIXED_NOW.getTime() + days * DAY_MS).toISOString();
}

function event(id: string, conceptId: string): LearningEvent {
  return {
    id,
    userId: "u_week",
    sessionId: "sess_week",
    courseId: "course_transformers_w4",
    sourceId: null,
    createdAt: FIXED_NOW.toISOString(),
    transcript: `note ${conceptId}`,
    cleanedTranscript: `note ${conceptId}`,
    origin: "typed",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    intent: "remember",
    conceptIds: [conceptId],
    primaryConceptId: conceptId,
    importance: 0.5,
    confusion: 0,
    confidenceSelfReport: null,
    sourceLocator: null,
    interpretationConfidence: 0.8,
    evidenceIds: [],
    requestedAction: "store",
    status: "grounded",
  };
}

/** One real turn, recorded the way a route records it. */
async function say(
  s: FileEventStore,
  user: string,
  conceptId: string,
  over: { intent?: LearningEvent["intent"]; assessment?: "correct" | "partial" | "incorrect"; confusion?: number } = {}
): Promise<void> {
  await s.recordLearning(user, {
    idempotencyKey: `${conceptId}-${over.intent ?? "claim"}-${over.assessment ?? "none"}`,
    sessionId: "sess_week",
    courseId: "course_transformers_w4",
    sourceId: null,
    transcript: `about ${conceptId}`,
    cleanedTranscript: `about ${conceptId}`,
    origin: "typed",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: over.intent ?? "claim",
    conceptIds: [conceptId],
    primaryConceptId: conceptId,
    importance: 0.6,
    confusion: over.confusion ?? 0.2,
    interpretationConfidence: 0.8,
    evidenceIds: [],
    requestedAction: "evaluate",
    status: "responded",
    sourceLocator: null,
    assessment: over.assessment ?? null,
  });
}

/**
 * A learner with a real, small history. Nothing here is invented on their
 * behalf: every number in the projection traces to one of these three turns.
 */
async function seededInput(user: string): Promise<PlannerInput> {
  const s = new FileEventStore();
  await say(s, user, "c_position", { assessment: "incorrect", confusion: 0.6 });
  await say(s, user, "c_qkv", { intent: "confusion", confusion: 0.9 });
  await say(s, user, "c_self_attention", { assessment: "correct" });
  const [mastery, events, queue, concepts] = await Promise.all([
    s.getMastery(user),
    s.listEvents(user, 50),
    s.getReviewQueue(user),
    s.getConcepts(user),
  ]);
  return {
    mastery,
    events,
    queue: queue.map((q) => ({ ...q, dueAt: atNow(1) })),
    concepts,
  };
}

const dayOf = (days: { segments: { conceptId: string }[] }[], conceptId: string) =>
  days.findIndex((d) => d.segments.some((s) => s.conceptId === conceptId));

describe("projectWeek", () => {
  it("is deterministic for a seeded store and mirrors the daily path on day 0", async () => {
    const user = `demo_week_seed_${Date.now().toString(36)}`;
    const input = await seededInput(user);

    const first = projectWeek(input, FIXED_NOW);
    const second = projectWeek(input, FIXED_NOW);
    expect(second).toEqual(first);

    expect(first.days).toHaveLength(WEEK_DAYS);
    expect(first.days[0].label).toBe("Today");
    expect(first.days[0].date).toBe("2026-09-11");
    expect(first.days[1].label).toBe("Tomorrow");
    expect(first.generatedAt).toBe(FIXED_NOW.toISOString());

    // Day 0 = the same concepts /api/learner/path selects from this state:
    // the wrong answer first, then the weakest thing they touched, then the
    // one they got right.
    expect(first.days[0].segments.map((s) => s.conceptId)).toEqual(["c_position", "c_qkv", "c_self_attention"]);
    expect(first.days[0].count).toBe(3);
    expect(first.days[0].segments.every((s) => s.title.length > 0 && s.reason.length > 0)).toBe(true);

    // Every concept the learner touched is already placed on Today, so no
    // queue item is left to escalate: the rest of the week is honestly empty.
    expect(first.days.slice(1).every((d) => d.count === 0)).toBe(true);

    // A concept appears at most once across the week.
    const ids = first.days.flatMap((d) => d.segments.map((s) => s.conceptId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("escalates due dates per the spacing rule: stored queue dueAt is honored", () => {
    const input: PlannerInput = {
      mastery: {},
      events: [],
      queue: [
        { conceptId: "c_soon", dueAt: atNow(1), priority: 0.6, reason: "due soon" },
        { conceptId: "c_later", dueAt: atNow(3), priority: 0.58, reason: "due later" },
      ],
      concepts: [
        { id: "c_soon", name: "Soon" },
        { id: "c_later", name: "Later" },
      ],
    };
    const { days } = projectWeek(input, FIXED_NOW);
    expect(dayOf(days, "c_soon")).toBe(1);
    expect(dayOf(days, "c_later")).toBe(3);
  });

  it("spaces unqueued ladder candidates one day at a time in rank order", () => {
    const mk = (id: string, mastery: number) => ({ ...blankMastery(id, FIXED_NOW.toISOString()), mastery, exposureCount: 1 });
    const input: PlannerInput = {
      mastery: { c_a: mk("c_a", 0.3), c_b: mk("c_b", 0.45), c_c: mk("c_c", 0.7) },
      events: [event("e1", "c_a"), event("e2", "c_b"), event("e3", "c_c")],
      queue: [],
      concepts: [
        { id: "c_a", name: "A" },
        { id: "c_b", name: "B" },
        { id: "c_c", name: "C" },
      ],
    };
    const { days } = projectWeek(input, FIXED_NOW);
    // Path takes only the weakest today; the rest escalate one per day.
    expect(days[0].segments.map((s) => s.conceptId)).toEqual(["c_a"]);
    expect(days[1].segments.map((s) => s.conceptId)).toEqual(["c_b"]);
    expect(days[2].segments.map((s) => s.conceptId)).toEqual(["c_c"]);
  });

  it("returns a complete, empty week for a learner with no state", () => {
    const { days, generatedAt } = projectWeek({ mastery: {}, events: [], queue: [], concepts: [] }, FIXED_NOW);
    expect(days).toHaveLength(WEEK_DAYS);
    expect(days.map((d) => d.label)).toEqual(["Today", "Tomorrow", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"]);
    expect(days.every((d) => d.count === 0 && d.segments.length === 0)).toBe(true);
    expect(generatedAt).toBe(FIXED_NOW.toISOString());
  });
});

describe("GET /api/learner/week", () => {
  it("returns 7 deterministic days for the resolved identity", async () => {
    const res = await weekGet(new NextRequest("http://localhost/api/learner/week"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: { label: string; count: number }[]; generatedAt: string };
    expect(body.days).toHaveLength(WEEK_DAYS);
    expect(body.days[0].label).toBe("Today");
    // A cold identity has nothing to review, and the week says so rather than
    // filling itself with a history this person does not have.
    expect(body.days.every((d) => d.count === 0)).toBe(true);
    expect(typeof body.generatedAt).toBe("string");

    const res2 = await weekGet(new NextRequest("http://localhost/api/learner/week"));
    const body2 = (await res2.json()) as { days: unknown[] };
    expect(body2.days).toEqual(body.days);
  });
});
