import { describe, expect, it } from "vitest";
import { resolveSubject } from "@/lib/courses/subject";
import { buildSubject } from "@/lib/intake/build";
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

      // B's event list shows none of A's data (B has no history at all).
      const bEvents = await s.listEvents(b, 100);
      expect(bEvents.find((e) => e.userId === a)).toBeUndefined();
      expect(bEvents.some((e) => `${e.transcript} ${e.cleanedTranscript}`.includes(marker))).toBe(false);

      // B's chunk pool excludes A's upload; A's pool includes it.
      const bChunks = await s.getCourseChunks(b);
      expect(bChunks.some((c) => c.sourceId === added.sourceId)).toBe(false);
      expect(bChunks.some((c) => c.text.includes(marker))).toBe(false);
      const aChunks = await s.getCourseChunks(a);
      expect(aChunks.some((c) => c.sourceId === added.sourceId)).toBe(true);

      // deleteUserData isolation: wiping A leaves B untouched, A comes back empty.
      await s.deleteUserData(a);
      const aAfter = await s.listEvents(a);
      expect(aAfter.length).toBe(0);
      expect(aAfter.some((e) => `${e.transcript} ${e.cleanedTranscript}`.includes(marker))).toBe(false);
      const bAfter = await s.listEvents(b, 100);
      expect(bAfter.length).toBe(0);
      const bChunksAfter = await s.getCourseChunks(b);
      expect(bChunksAfter.some((c) => c.text.includes(marker))).toBe(false);
    } finally {
      await s.deleteUserData(a).catch(() => {});
      await s.deleteUserData(b).catch(() => {});
    }
  });
});

describe("cross-user isolation of a subject someone built", () => {
  it("B cannot list, resolve, or retrieve from A's subject even holding its id", async () => {
    const s = new FileEventStore();
    const tag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const a = `u_subj_a_${tag}`;
    const b = `u_subj_b_${tag}`;
    const marker = `private-marker-${tag}`;
    const notes = [
      `The ${marker} protocol is a procedure for staining tissue sections before microscopy.`,
      "Fixation preserves the structure of the tissue so that it does not degrade during handling.",
      "Dehydration removes water from the sample by passing it through increasing concentrations of ethanol.",
      "Embedding surrounds the dehydrated tissue in paraffin wax so that thin sections can be cut.",
      "Sectioning uses a microtome to cut ribbons a few micrometres thick from the wax block.",
      "Staining applies haematoxylin and eosin so that nuclei and cytoplasm take different colours.",
      "Mounting places a coverslip over the stained section with a resin that matches the refractive index of glass.",
      "Each of these steps is repeated in the same order for every sample so that the results can be compared.",
      "Antigen retrieval reverses some of the cross-linking that fixation caused, which lets antibodies reach their targets again.",
      "Counterstaining adds a second colour so that the structures the primary stain missed are still visible under the microscope.",
      "Decalcification is required for bone, because a microtome blade cannot cut through mineralised tissue without shattering it.",
      "Quality control checks that every section on the slide is the same thickness and that no folds or tears were introduced.",
    ].join(" ");

    try {
      const built = await buildSubject({ kind: "paste", title: "Histology methods", text: notes }, a);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      await s.saveSubject(a, built.subject);
      const id = built.subject.id;

      // A can open it.
      expect((await s.getSubject(a, id))?.id).toBe(id);
      expect((await resolveSubject(s, a, id)).id).toBe(id);

      // B holds the exact id and still gets nothing of A's.
      expect(await s.getSubject(b, id)).toBeNull();
      expect(await s.listSubjects(b)).toEqual([]);

      // Resolving B against A's id fails loudly. It used to fall back to the
      // default starter, which hid the miss and taught B a syllabus nobody
      // chose; a coded miss is both safer and honest.
      await expect(resolveSubject(s, b, id)).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND" });

      // Nothing of A's text is reachable from B, by chunk pool or by search.
      const bChunks = await s.getCourseChunks(b, id);
      expect(bChunks.some((c) => c.text.includes(marker))).toBe(false);
      const bHits = await s.retrieveEvidence(b, marker, { courseId: id, limit: 5 });
      expect(bHits.some((h) => h.chunk.text.includes(marker))).toBe(false);

      // A's own search does find it.
      const aHits = await s.retrieveEvidence(a, `${marker} staining tissue sections`, { courseId: id, limit: 5 });
      expect(aHits.some((h) => h.chunk.text.includes(marker))).toBe(true);

      // Deleting B leaves A's subject intact.
      await s.deleteUserData(b);
      expect((await s.getSubject(a, id))?.id).toBe(id);
    } finally {
      await s.deleteUserData(a).catch(() => {});
      await s.deleteUserData(b).catch(() => {});
    }
  });
});
