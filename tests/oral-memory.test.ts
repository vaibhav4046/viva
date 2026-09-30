import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import type { ConceptMastery } from "@/lib/types";
import { buildLearnerBrief, EPHEMERAL_HISTORY_NOTE } from "@/lib/oral/learner-brief";
import { buildOralSystemPrompt, oralGreeting, ORAL_PROMPT_VERSION } from "@/lib/oral/prompt";
import { chooseNext } from "@/lib/oral/next-concept";
import { turnsFromEvents } from "@/lib/oral/steering";

const NOW = "2026-09-29T12:00:00.000Z";
const CONCEPTS = [
  { id: "c_self_attention", name: "Self-attention" },
  { id: "c_qkv", name: "Queries, Keys, Values" },
  { id: "c_position", name: "Positional information" },
  { id: "c_multihead", name: "Multi-head attention" },
];

type Outcome = "correct" | "partial" | "incorrect";

/** The learner map after a first session, folded by the same reducer the store uses. */
function foldSession(results: [string, Outcome][]): Record<string, ConceptMastery> {
  let map: Record<string, ConceptMastery> = {};
  for (const [id, assessment] of results) {
    const prev = map[id] ?? blankMastery(id, NOW);
    map = { ...map, [id]: reduceMastery(prev, { intent: "claim", createdAt: NOW, assessment }).next };
  }
  return map;
}

const promptFor = (durable: boolean, mastery: Record<string, ConceptMastery>) =>
  buildOralSystemPrompt({
    subjectTitle: "Transformers, week 4",
    concepts: CONCEPTS.map((c) => c.name),
    languages: ["en"],
    sourceTitles: ["Lecture 4"],
    brief: buildLearnerBrief({ concepts: CONCEPTS, mastery, durable }),
  });

// Session one: multi-head answered wrong twice, queries right once, self-attention right twice.
const AFTER_SESSION_ONE = foldSession([
  ["c_self_attention", "correct"],
  ["c_self_attention", "correct"],
  ["c_qkv", "correct"],
  ["c_multihead", "incorrect"],
  ["c_multihead", "incorrect"],
]);

describe("the second session reads the stored map", () => {
  it("first session with an empty map says there is no history and asks the learner to choose", () => {
    const p = promptFor(true, {});
    expect(p).toContain("STORED HISTORY: none for this student on this subject.");
    expect(p).toContain("Do not say or imply that you remember them");
    expect(p).toContain("asking for the first thing they want to be examined on");
    expect(p).not.toContain("weakest first");
  });

  it("second session prompt differs from the first and opens on the weakest stored concept", () => {
    const first = promptFor(true, {});
    const second = promptFor(true, AFTER_SESSION_ONE);
    expect(second).not.toBe(first);
    expect(second).toContain("Open the exam with one recall question on Multi-head attention.");
    // Weakest first: multi-head, then the concept that was right once, then the one right twice.
    const block = second.split("weakest first:")[1].split("State only what is listed")[0];
    const order = ["Multi-head attention", "Queries, Keys, Values", "Self-attention"].map((n) => block.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(block).toContain("Multi-head attention: Mixed up, missed 2 times, 2 misconceptions recorded");
    // Concepts the learner never touched are not listed as history.
    expect(block).not.toContain("Positional information");
  });

  it("the chooser and the prompt agree on the opening concept", () => {
    const brief = buildLearnerBrief({ concepts: CONCEPTS, mastery: AFTER_SESSION_ONE, durable: true });
    const first = chooseNext({ concepts: CONCEPTS, mastery: AFTER_SESSION_ONE, turns: [] });
    expect(brief.opening?.conceptId).toBe(first?.conceptId);
    expect(brief.opening?.conceptId).toBe("c_multihead");
    expect(first?.kind).toBe("recall");
  });

  it("ignores concepts that belong to another subject", () => {
    const mixed = { ...AFTER_SESSION_ONE, c_other_subject: { ...blankMastery("c_other_subject", NOW), exposureCount: 3, mastery: 0.05 } };
    const p = promptFor(true, mixed);
    expect(p).not.toContain("c_other_subject");
    expect(p).toContain("Open the exam with one recall question on Multi-head attention.");
  });

  it("says the opening concept has not been examined when the touched ones are all solid", () => {
    const solid = foldSession([["c_self_attention", "correct"], ["c_self_attention", "correct"], ["c_self_attention", "correct"], ["c_self_attention", "correct"]]);
    const brief = buildLearnerBrief({ concepts: CONCEPTS, mastery: solid, durable: true });
    expect(brief.status).toBe("stored");
    expect(brief.opening).toMatchObject({ conceptId: "c_qkv", examinedBefore: false });
    expect(promptFor(true, solid)).toContain("which their record does not cover yet");
  });
});

describe("the spoken greeting", () => {
  const brief = (mastery: Record<string, ConceptMastery>) => buildLearnerBrief({ concepts: CONCEPTS, mastery, durable: true });

  it("hands the choice to the student when nothing is stored", () => {
    expect(oralGreeting(brief({}))).toBe("You're being examined. Tell me what you want to be asked on, and I'll start there.");
  });

  it("names the weakest stored concept when there is history", () => {
    const g = oralGreeting(brief(AFTER_SESSION_ONE));
    expect(g).toContain("Multi-head attention");
    expect(g).toContain("your recorded answers show as your weakest");
    expect(g).not.toMatch(/[!]|—|–/);
  });
});

describe("no fake memory", () => {
  it("ephemeral storage with an empty map says so and promises nothing", () => {
    const brief = buildLearnerBrief({ concepts: CONCEPTS, mastery: {}, durable: false });
    expect(brief).toMatchObject({ status: "empty", durable: false });
    expect(brief.note).toContain("does not keep history across restarts");
    const p = promptFor(false, {});
    expect(p).toContain(EPHEMERAL_HISTORY_NOTE);
    expect(p).toContain("Do not promise the student that this will be remembered next time.");
  });

  it("ephemeral storage with a stored map still steers, and warns that the history can vanish", () => {
    const brief = buildLearnerBrief({ concepts: CONCEPTS, mastery: AFTER_SESSION_ONE, durable: false });
    expect(brief.status).toBe("stored");
    expect(brief.note).toContain(EPHEMERAL_HISTORY_NOTE);
    const p = promptFor(false, AFTER_SESSION_ONE);
    expect(p).toContain("Open the exam with one recall question on Multi-head attention.");
    expect(p).toContain(EPHEMERAL_HISTORY_NOTE);
  });

  it("durable storage with an empty map does not mention temporary storage", () => {
    const p = promptFor(true, {});
    expect(p).not.toContain("temporary");
  });

  it("a row that was never exposed does not count as history", () => {
    const seeded = { c_qkv: { ...blankMastery("c_qkv", NOW), exposureCount: 0 } };
    expect(buildLearnerBrief({ concepts: CONCEPTS, mastery: seeded, durable: true }).status).toBe("empty");
  });

  it("carries the prompt version that names this behaviour", () => {
    expect(ORAL_PROMPT_VERSION).toBe("2026-09-29.3");
  });
});

describe("turnsFromEvents", () => {
  it("keeps only this exam's answers, in order, with the assessment as the result", () => {
    const ev = (sessionId: string, primaryConceptId: string, assessment: Outcome | null) => ({ sessionId, primaryConceptId, assessment, masterySignal: null });
    const turns = turnsFromEvents([ev("s1", "c_qkv", "correct"), ev("other", "c_position", "incorrect"), ev("s1", "c_multihead", "incorrect")], "s1");
    expect(turns).toEqual([
      { conceptId: "c_qkv", result: "correct" },
      { conceptId: "c_multihead", result: "incorrect" },
    ]);
  });
});

describe("GET /api/oral/session with a real store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "viva-oral-memory-"));
  const USER = "demo_00000000000000000000000000c0de02";
  const savedEnv = { VERCEL: process.env.VERCEL, DATA_DIR: process.env.DATA_DIR, DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL };

  beforeAll(() => {
    process.env.DATA_DIR = dir;
    // The demo server's file store lives in /tmp on Vercel and is not durable; dbStatus keys off this.
    process.env.VERCEL = "1";
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    vi.resetModules();
    vi.doMock("@/lib/auth/identity", () => ({ resolveIdentity: async () => ({ identity: { userId: USER, kind: "demo" } }) }));
  });
  afterAll(() => {
    vi.doUnmock("@/lib/auth/identity");
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* EBUSY on Windows, retry */ }
    }
  });

  it("a second session after recorded wrong answers gets a different prompt that opens on the weak concept", async () => {
    const { GET } = await import("@/app/api/oral/session/route");
    const { getStore } = await import("@/lib/store");
    const req = () => new Request("http://localhost/api/oral/session");

    const before = await (await GET(req())).json();
    expect(before.system_prompt).toContain("STORED HISTORY: none");
    expect(before.memory).toMatchObject({ status: "empty", durable: false, opening: null });
    expect(before.promptVersion).toBe(ORAL_PROMPT_VERSION);

    // What /api/oral/tool writes for each checked answer: intent claim with an assessment.
    const store = getStore();
    for (const [i, assessment] of (["incorrect", "incorrect"] as const).entries()) {
      await store.recordLearning(USER, {
        idempotencyKey: `oral_memory_test_${i}`,
        sessionId: "oral_session_one",
        courseId: "course_transformers_w4",
        sourceId: null,
        transcript: "I think it runs a single head over the input.",
        cleanedTranscript: "I think it runs a single head over the input.",
        origin: "voice",
        transcriptionConfidence: null,
        transcriptionLatencyMs: null,
        transcriptionSessionId: null,
        intent: "claim",
        conceptIds: ["c_multihead"],
        primaryConceptId: "c_multihead",
        importance: 0.5,
        confusion: 0.8,
        interpretationConfidence: 0.8,
        evidenceIds: [],
        requestedAction: "evaluate",
        status: "responded",
        sourceLocator: null,
        assessment,
        masterySignal: "down",
        hint: null,
      });
    }

    const after = await (await GET(req())).json();
    expect(after.system_prompt).not.toBe(before.system_prompt);
    expect(after.system_prompt).toContain("Open the exam with one recall question on Multi-head attention.");
    expect(after.system_prompt).toContain(EPHEMERAL_HISTORY_NOTE);
    expect(after.memory).toMatchObject({ status: "stored", durable: false, opening: "Multi-head attention" });
    expect(after.greeting).toContain("Multi-head attention");
    expect(before.greeting).not.toContain("Multi-head attention");


    // The same map on a disk that survives restarts: same steering, no warning about losing it.
    delete process.env.VERCEL;
    const onDisk = await (await GET(req())).json();
    expect(onDisk.memory).toMatchObject({ status: "stored", durable: true, opening: "Multi-head attention" });
    expect(onDisk.system_prompt).not.toContain(EPHEMERAL_HISTORY_NOTE);
    await store.deleteUserData(USER);
  });
});
