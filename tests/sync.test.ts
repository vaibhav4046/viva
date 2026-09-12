import { describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import { SyncRequestSchema, applySync, learnerSnapshot } from "@/lib/sync";
import type { RecordInput } from "@/lib/store/repo";
import type { Subject } from "@/lib/courses/types";

/**
 * Replay must be safe to run twice, and must fold to the same map the live
 * turns folded to. Both of those are load-bearing: a student who reloads sees
 * their own mastery move if either one is wrong.
 */

const COURSE = "course_transformers_w4";

function live(over: Partial<RecordInput> = {}): RecordInput {
  return {
    idempotencyKey: `k_${Math.random().toString(36).slice(2)}`,
    sessionId: "sess_t",
    courseId: COURSE,
    sourceId: "src_transformers_intro",
    transcript: "I don't understand positional encoding.",
    cleanedTranscript: "I don't understand positional encoding.",
    origin: "typed",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: "confusion",
    conceptIds: ["c_position"],
    primaryConceptId: "c_position",
    importance: 0.7,
    confusion: 0.9,
    interpretationConfidence: 0.88,
    evidenceIds: ["ch_pos_1"],
    requestedAction: "explain",
    status: "responded",
    sourceLocator: { section: "3", page: 11 },
    ...over,
  };
}

/** What the browser holds: the event the route returned, plus its own id. */
function mirrored(event: unknown, clientEventId: string) {
  return { ...(event as Record<string, unknown>), clientEventId };
}

function req(body: unknown) {
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) throw new Error(`schema rejected the whole body: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

describe("learner sync — replay", () => {
  it("replays a record into an empty store and returns the merged state", async () => {
    const s = new FileEventStore();
    const lived = `u_sync_${Date.now()}_a`;
    const fresh = `u_sync_${Date.now()}_b`;

    const a = await s.recordLearning(lived, live({ idempotencyKey: "c1" }));
    const b = await s.recordLearning(lived, live({
      idempotencyKey: "c2", intent: "claim", assessment: "incorrect",
      transcript: "Backpropagation and gradient descent are the same thing.",
      cleanedTranscript: "Backpropagation and gradient descent are the same thing.",
      primaryConceptId: "c_backprop", conceptIds: ["c_backprop"],
    }));

    // A different lambda: empty store, same browser record.
    expect(await s.listEvents(fresh)).toHaveLength(0);
    const report = await applySync(s, fresh, req({
      events: [mirrored(b.event, "c2"), mirrored(a.event, "c1")],
    }));

    expect(report.events).toEqual({ applied: 2, duplicate: 0, rejected: 0 });
    const view = await learnerSnapshot(s, fresh, COURSE);
    expect(view.events).toHaveLength(2);
    expect(Object.keys(view.mastery).sort()).toEqual(["c_backprop", "c_position"]);
    // The point of the whole exercise: the replayed map equals the lived map.
    expect(view.mastery).toEqual(await s.getMastery(lived));

    await s.deleteUserData(lived);
    await s.deleteUserData(fresh);
  });

  it("a replay run twice does not move mastery a second time", async () => {
    const s = new FileEventStore();
    const lived = `u_sync_${Date.now()}_c`;
    const fresh = `u_sync_${Date.now()}_d`;

    const events = [];
    for (const [key, over] of [
      ["c1", {}],
      ["c2", { intent: "claim" as const, assessment: "correct" as const }],
      ["c3", { intent: "claim" as const, masterySignal: "flat" as const }],
      ["c4", { intent: "teachback" as const, assessment: "partial" as const, teachbackScore: 0.5 }],
    ] as const) {
      const r = await s.recordLearning(lived, live({ idempotencyKey: key, ...over }));
      events.push(mirrored(r.event, key));
    }

    const first = await applySync(s, fresh, req({ events }));
    const afterFirst = await s.getMastery(fresh);
    const second = await applySync(s, fresh, req({ events }));
    const afterSecond = await s.getMastery(fresh);
    const third = await applySync(s, fresh, req({ events }));

    expect(first.events).toEqual({ applied: 4, duplicate: 0, rejected: 0 });
    expect(second.events).toEqual({ applied: 0, duplicate: 4, rejected: 0 });
    expect(third.events).toEqual({ applied: 0, duplicate: 4, rejected: 0 });
    expect(afterSecond).toEqual(afterFirst);
    expect(await s.getMastery(fresh)).toEqual(afterFirst);
    expect(await s.listEvents(fresh)).toHaveLength(4);
    // And still the same numbers the live session produced.
    expect(afterFirst).toEqual(await s.getMastery(lived));

    await s.deleteUserData(lived);
    await s.deleteUserData(fresh);
  });

  it("an unchecked claim replays flat — the stored signal is what makes that possible", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_e`;
    const lived = await s.recordLearning(u, live({
      idempotencyKey: "flat1", intent: "claim", masterySignal: "flat",
      primaryConceptId: "c_attention", conceptIds: ["c_attention"],
    }));
    expect(lived.event.masterySignal).toBe("flat");
    expect(lived.delta).toBe(0);

    const fresh = `u_sync_${Date.now()}_f`;
    await applySync(s, fresh, req({ events: [mirrored(lived.event, "flat1")] }));
    const replayed = (await s.getMastery(fresh)).c_attention;
    expect(replayed.mastery).toBe(0.5); // not 0.48 — nothing was checked, nothing moves
    expect(replayed).toEqual((await s.getMastery(u)).c_attention);

    await s.deleteUserData(u);
    await s.deleteUserData(fresh);
  });

  it("keeps the learner's own timestamps instead of stamping everything now", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_g`;
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    await applySync(s, u, req({
      events: [{ clientEventId: "old1", createdAt: yesterday, intent: "confusion", transcript: "I am lost on softmax.", primaryConceptId: "c_attention" }],
    }));
    expect((await s.listEvents(u))[0].createdAt).toBe(yesterday);
    await s.deleteUserData(u);
  });

  it("refuses a timestamp it cannot use, and still lands the rest", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_h`;
    const report = await applySync(s, u, req({
      events: [
        { clientEventId: "bad1", createdAt: "not a date", intent: "confusion", transcript: "one" },
        { clientEventId: "bad2", createdAt: "1998-01-01T00:00:00.000Z", intent: "confusion", transcript: "two" },
        { clientEventId: "ok1", intent: "confusion", transcript: "three", primaryConceptId: "c_position" },
      ],
    }));
    expect(report.events).toEqual({ applied: 1, duplicate: 0, rejected: 2 });
    expect(report.rejected.map((r) => r.id)).toEqual(["bad1", "bad2"]);
    expect(await s.listEvents(u)).toHaveLength(1);
    await s.deleteUserData(u);
  });

  it("carries the Dictation evidence back through a replay", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_dict`;
    const lived = await s.recordLearning(u, live({
      idempotencyKey: "d1", origin: "voice",
      transcriptionConfidence: 0.99, transcriptionLatencyMs: 554,
      transcriptionMode: "sync", transcriptionFellBackFrom: "dictation",
      transcriptVerbatim: "I don't understand positional in coding.",
    }));
    expect(lived.event.transcriptionMode).toBe("sync");

    // The reload the footer used to not survive.
    const fresh = `u_sync_${Date.now()}_dict2`;
    await applySync(s, fresh, req({ events: [mirrored(lived.event, "d1")] }));
    const back = (await s.listEvents(fresh))[0];
    expect(back.origin).toBe("voice");
    expect(back.transcriptionMode).toBe("sync");
    expect(back.transcriptionFellBackFrom).toBe("dictation");
    expect(back.transcriptionLatencyMs).toBe(554);
    expect(back.transcriptionConfidence).toBe(0.99);
    expect(back.transcriptVerbatim).toBe("I don't understand positional in coding.");
    // And the edited text is still the text — the two never share a field.
    expect(back.transcript).toBe("I don't understand positional encoding.");

    await s.deleteUserData(u);
    await s.deleteUserData(fresh);
  });

  it("keeps external-dictation instead of collapsing it to typed", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_ext`;
    await applySync(s, u, req({
      events: [{ clientEventId: "x1", intent: "note", transcript: "Pasted from my own dictation tool.", origin: "external-dictation" }],
    }));
    expect((await s.listEvents(u))[0].origin).toBe("external-dictation");
    await s.deleteUserData(u);
  });

  it("never takes mastery from the client — only events fold", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_i`;
    // A client posting itself a perfect map, with the numbers spelled out.
    await applySync(s, u, req({
      events: [{ clientEventId: "m1", intent: "confusion", transcript: "I do not get this at all.", primaryConceptId: "c_position" }],
      mastery: { c_position: { conceptId: "c_position", mastery: 1, exposureCount: 99 } },
    } as unknown));
    const m = (await s.getMastery(u)).c_position;
    expect(m.mastery).toBeLessThan(0.5); // a confusion, folded — not the 1 it asked for
    expect(m.exposureCount).toBe(1);
    await s.deleteUserData(u);
  });
});

describe("learner sync — subjects", () => {
  const subject = (id: string): Partial<Subject> => ({
    id,
    code: "COMP319",
    title: "COMP319 Networks — TCP congestion control",
    subject: "Networks",
    origin: "paste",
    builtBy: "reading",
    keyterms: ["slow start", "ssthresh"],
    languageCodes: ["en"],
    sources: [{
      id: "src_own_1", title: "My notes", type: "notes",
      chunks: [{ id: "ch_own_1", sourceId: "src_own_1", ordinal: 0, text: "Slow start doubles cwnd each RTT until ssthresh.", locator: { section: "1" } }],
    }],
    concepts: [{ id: "c_slowstart", name: "Slow start", aliases: ["slow-start"], description: "cwnd growth", related: [] }],
    examQuestions: [{ id: "q_own_1", conceptId: "c_slowstart", question: "What does slow start do?", requiredKeywords: ["double", "cwnd"], hint: "Think per RTT." }],
    teachback: { keywords: { c_slowstart: ["double"] }, hints: { c_slowstart: "Per RTT." } },
    explainers: {},
    traps: [],
  });

  it("a replayed subject becomes readable, listed, and owned by the caller", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_j`;
    const report = await applySync(s, u, req({ subjects: [{ ...subject("subject_own_1"), ownerId: "somebody_else", demo: true }] }));
    expect(report.subjects).toEqual({ applied: 1, duplicate: 0, rejected: 0 });

    const back = await s.getSubject(u, "subject_own_1");
    expect(back?.title).toBe("COMP319 Networks — TCP congestion control");
    expect(back?.ownerId).toBe(u);          // never the id the client claimed
    expect(back?.demo).toBe(false);         // and never a starter
    const view = await learnerSnapshot(s, u, "subject_own_1");
    expect(view.activeCourseId).toBe("subject_own_1");
    expect(view.courses.some((c) => (c as { id: string }).id === "subject_own_1")).toBe(true);
    await s.deleteUserData(u);
  });

  it("replaying a subject twice does not duplicate or overwrite it", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_k`;
    await applySync(s, u, req({ subjects: [subject("subject_own_2")] }));
    const again = await applySync(s, u, req({ subjects: [{ ...subject("subject_own_2"), title: "Renamed by a stale tab" }] }));
    expect(again.subjects).toEqual({ applied: 0, duplicate: 1, rejected: 0 });
    expect((await s.getSubject(u, "subject_own_2"))?.title).toBe("COMP319 Networks — TCP congestion control");
    expect(await s.listSubjects(u)).toHaveLength(1);
    await s.deleteUserData(u);
  });

  it("an event naming a replayed subject lands on that subject's material", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_l`;
    await applySync(s, u, req({
      subjects: [subject("subject_own_3")],
      events: [{ clientEventId: "s1", intent: "confusion", transcript: "I do not follow ssthresh.", courseId: "subject_own_3", primaryConceptId: "c_slowstart" }],
    }));
    const view = await learnerSnapshot(s, u, "subject_own_3");
    expect(view.activeCourseId).toBe("subject_own_3");
    expect(view.events).toHaveLength(1);
    expect(Object.keys(view.mastery)).toEqual(["c_slowstart"]);
    await s.deleteUserData(u);
  });

  it("a subject missing its concepts is refused without costing the events", async () => {
    const s = new FileEventStore();
    const u = `u_sync_${Date.now()}_m`;
    const body = {
      subjects: [{ ...subject("subject_own_4"), concepts: undefined }],
      events: [{ clientEventId: "k1", intent: "confusion", transcript: "still worth keeping" }],
    };
    // The bad subject fails the schema, so the client is told which field —
    // rather than the server quietly writing a subject with no map.
    expect(SyncRequestSchema.safeParse(body).success).toBe(false);
    const only = await applySync(s, u, req({ events: body.events }));
    expect(only.events.applied).toBe(1);
    await s.deleteUserData(u);
  });
});

/**
 * Route-level: the three ways a browser's mirror can be wrong without it being
 * the server's problem. Each one used to be, or could have been, a 500 — and a
 * 500 here tells the browser its whole record failed.
 */
describe("POST /api/learner/sync — the edges", () => {
  const post = async (body: unknown, query = "") => {
    const { POST } = await import("@/app/api/learner/sync/route");
    const req = new Request(`http://localhost/api/learner/sync${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    return { status: res.status, json: (await res.json()) as unknown };
  };

  it("answers 404, not 500, when the view names a subject that does not resolve", async () => {
    const r = await post(
      { events: [{ clientEventId: `e404_${Date.now()}`, intent: "confusion", transcript: "keep this anyway" }] },
      "?subject=subject_not_here"
    );
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("SUBJECT_NOT_FOUND");
  });

  it("turns away more than the cap in one go rather than half-applying it", async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({ clientEventId: `cap${i}`, intent: "note", transcript: "x" }));
    const r = await post({ events });
    expect(r.status).toBe(400);
    expect((r.json as { error: { message: string } }).error.message).toMatch(/At most 200 notes/);
  });

  it("turns away an oversize body even when nothing declared its length", async () => {
    const r = await post(`{"events":[],"pad":"${"p".repeat(600_000)}"}`);
    expect(r.status).toBe(413);
    expect((r.json as { error: { code: string } }).error.code).toBe("SYNC_TOO_LARGE");
  });

  it("says where the record lives when nothing durable is behind it", async () => {
    const r = await post({ events: [] });
    expect(r.status).toBe(200);
    const j = r.json as { durable: boolean; storageNote: string | null };
    // Locally there IS a durable file store, so the note is only owed when
    // there is not — the two must never disagree.
    expect(j.storageNote === null).toBe(j.durable);
    if (!j.durable) expect(j.storageNote).toMatch(/in this browser/i);
  });
});
