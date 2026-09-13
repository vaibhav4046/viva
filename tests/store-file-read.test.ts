import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FileEventStore } from "@/lib/store/file";
import type { RecordInput } from "@/lib/store/repo";

/**
 * A read must not write.
 *
 * `load()` used to end in a bare catch that seeded a blank doc and saved it,
 * so every read path — listEvents, getMastery, listSubjects, getConcepts —
 * performed a write, and did it outside `withLock`, racing the locked writers
 * the mutex exists to serialise. Worse, the catch could not tell "no file yet"
 * from "this file did not parse", so a torn doc — exactly what the old shared
 * tmp path used to produce — was replaced by a blank one on a plain read. A
 * student's whole history, deleted by looking at it.
 *
 * This is the degraded fallback for Postgres: it runs when things are already
 * going wrong, which is the worst moment to lose the only copy.
 */

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-store-read-"));
  process.env.DATA_DIR = tmp;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  for (const f of await fs.readdir(tmp)) await fs.rm(path.join(tmp, f), { force: true });
});

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    idempotencyKey: `k_${Math.random().toString(36).slice(2)}`,
    sessionId: "sess_t",
    courseId: "course_transformers_w4",
    sourceId: "src_transformers_intro",
    transcript: "I don't understand positional encoding.",
    cleanedTranscript: "I don't understand positional encoding.",
    origin: "voice",
    transcriptionConfidence: 0.93,
    transcriptionLatencyMs: 240,
    transcriptionSessionId: "sess_abc",
    intent: "confusion",
    conceptIds: ["c_position"],
    primaryConceptId: "c_position",
    importance: 0.7,
    confusion: 0.9,
    interpretationConfidence: 0.88,
    evidenceIds: ["ch_pos_1"],
    requestedAction: "explain",
    status: "grounded",
    sourceLocator: { section: "3", page: 11 },
    ...over,
  };
}

const userFile = (userId: string) => path.join(tmp, `${userId}.json`);

describe("file store: reads never write", () => {
  it("a read of a doc that did not parse leaves every byte of it on disk", async () => {
    const s = new FileEventStore();
    const u = "u_torn";
    await s.recordLearning(u, input());
    const whole = await fs.readFile(userFile(u), "utf-8");
    expect(whole).toContain("positional encoding");

    // Half a write, the shape the shared-tmp bug produced.
    const torn = whole.slice(0, Math.floor(whole.length / 2));
    await fs.writeFile(userFile(u), torn, "utf-8");

    await expect(s.listEvents(u)).rejects.toThrow(/did not parse/);
    expect(await fs.readFile(userFile(u), "utf-8")).toBe(torn);
  });

  it("a write repairs a torn doc by moving it aside, never by overwriting it", async () => {
    const s = new FileEventStore();
    const u = "u_repair";
    await s.recordLearning(u, input());
    const torn = (await fs.readFile(userFile(u), "utf-8")).slice(0, 40);
    await fs.writeFile(userFile(u), torn, "utf-8");

    await s.recordLearning(u, input({ idempotencyKey: "after-repair" }));

    const kept = (await fs.readdir(tmp)).filter((f) => f.includes(".corrupt-"));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, kept[0]), "utf-8")).toBe(torn);
    expect(await s.listEvents(u)).toHaveLength(1);
  });

  it("a read of a learner with no file yet writes nothing", async () => {
    const s = new FileEventStore();
    const u = "u_fresh";
    expect(await s.getMastery(u)).toEqual({});
    expect(await s.listEvents(u)).toEqual([]);
    expect(await s.listSubjects(u)).toEqual([]);
    await expect(fs.stat(userFile(u))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("a read cannot clobber the write holding the lock", async () => {
    const s = new FileEventStore();
    const u = "u_race";
    const write = s.recordLearning(u, input({ idempotencyKey: "under-lock" }));
    // Unlocked, and on a file that does not exist yet: the seed-on-read save
    // used to land after the locked save and erase the event.
    const reads = Array.from({ length: 8 }, () => s.getMastery(u));
    await Promise.all([write, ...reads]);

    expect(await s.listEvents(u)).toHaveLength(1);
    expect(Object.keys(await s.getMastery(u))).toEqual(["c_position"]);
  });

  it("a genuinely new learner still gets a seeded doc, persisted by the first real write", async () => {
    const s = new FileEventStore();
    const u = "u_new";
    // Seeded subject is available before anything is stored.
    expect((await s.getConcepts(u)).length).toBeGreaterThan(0);
    await s.saveTutorMessage(u, "sess", "user", "hello", []);
    const doc = JSON.parse(await fs.readFile(userFile(u), "utf-8"));
    expect(doc.userId).toBe(u);
    expect(doc.seeds.course_transformers_w4).toBe(true);
    expect(doc.events).toEqual([]);
  });
});
