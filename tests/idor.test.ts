import { describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import type { RecordInput } from "@/lib/store/repo";

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    idempotencyKey: `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    sessionId: "sess_idor",
    courseId: "course_transformers_w4",
    sourceId: "src_transformers_intro",
    transcript: "IDOR probe transcript A.",
    cleanedTranscript: "IDOR probe transcript A.",
    origin: "voice",
    transcriptionConfidence: 0.9,
    transcriptionLatencyMs: 200,
    transcriptionSessionId: null,
    intent: "confusion",
    conceptIds: ["c_position"],
    primaryConceptId: "c_position",
    importance: 0.7,
    confusion: 0.9,
    interpretationConfidence: 0.85,
    evidenceIds: ["ch_pos_1"],
    requestedAction: "explain",
    status: "grounded",
    sourceLocator: { section: "3", page: 11 },
    ...over,
  };
}

describe("cross-user isolation (IDOR)", () => {
  it("B sees none of A's events or uploaded chunks; deletes are isolated", async () => {
    const s = new FileEventStore();
    const tag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const a = `u_idor_a_${tag}`;
    const b = `u_idor_b_${tag}`;
    try {
      const marker = `secret-marker-${tag}`;
      await s.recordLearning(
        a,
        input({ transcript: `A private note ${marker}.`, cleanedTranscript: `A private note ${marker}.` })
      );
      const added = await s.addSource(a, {
        title: "A private upload",
        type: "notes",
        chunks: [{ text: `A private uploaded chunk ${marker} about positional order.`, section: "private" }],
      });

      // B's event list shows none of A's data (B holds only its own seed).
      const bEvents = await s.listEvents(b, 100);
      expect(bEvents.find((e) => e.userId === a)).toBeUndefined();
      expect(bEvents.some((e) => `${e.transcript} ${e.cleanedTranscript}`.includes(marker))).toBe(false);

      // B's chunk pool excludes A's upload; A's pool includes it.
      const bChunks = await s.getCourseChunks(b);
      expect(bChunks.some((c) => c.sourceId === added.sourceId)).toBe(false);
      expect(bChunks.some((c) => c.text.includes(marker))).toBe(false);
      const aChunks = await s.getCourseChunks(a);
      expect(aChunks.some((c) => c.sourceId === added.sourceId)).toBe(true);

      // deleteUserData isolation: wiping A leaves B untouched, A reseeds clean.
      await s.deleteUserData(a);
      const aAfter = await s.listEvents(a);
      expect(aAfter.length).toBe(1);
      expect(aAfter.some((e) => `${e.transcript} ${e.cleanedTranscript}`.includes(marker))).toBe(false);
      const bAfter = await s.listEvents(b, 100);
      expect(bAfter.length).toBe(1);
      const bChunksAfter = await s.getCourseChunks(b);
      expect(bChunksAfter.some((c) => c.text.includes(marker))).toBe(false);
    } finally {
      await s.deleteUserData(a).catch(() => {});
      await s.deleteUserData(b).catch(() => {});
    }
  });
});
