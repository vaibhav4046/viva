import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { setReasoningProvider, providerStatus, type ReasoningProvider } from "@/lib/ai/provider";
import { compileTranscript } from "@/lib/compiler";
import { getCourse } from "@/lib/courses";
import { assessAnswer, gradeAnswer } from "@/lib/tutor";
import { composeReply, groundReply, planTurn, readHistory, tutorReply, type TurnMemory } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";
import { POST as studyTurn } from "@/app/api/study/turn/route";

/**
 * The tutor brain with a stubbed model.
 *
 * No LLM credentials exist in CI, so every model path here runs against a stub
 * injected through the same seam the real provider uses. The five cases are the
 * ones that decide whether the product works: a follow-up keeps the concept, an
 * invented citation is dropped, a dead provider still answers, full keyword
 * coverage cannot be graded wrong, and a spoken answer beats a note while a
 * question is open.
 */

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: "u_brain", kind: "demo" as const } }) };
});

class StubProvider implements ReasoningProvider {
  readonly name = "stub-model";
  constructor(private readonly reply: (user: string) => unknown) {}
  async generateText(): Promise<string> { return ""; }
  async generateObject<T>(input: { system: string; user: string; schema: ZodType<T> }): Promise<T> {
    return input.schema.parse(this.reply(input.user));
  }
}

class DeadProvider implements ReasoningProvider {
  readonly name = "dead-model";
  async generateText(): Promise<string> { throw new Error("provider unreachable"); }
  async generateObject<T>(): Promise<T> { throw new Error("provider unreachable"); }
}

const COURSE = getCourse("course_transformers_w4");
const CHUNKS: SourceChunk[] = COURSE.sources.flatMap((s) => s.chunks).slice(0, 3);

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-brain-"));
  process.env.DATA_DIR = tmp;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => setReasoningProvider(null));

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/study/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("follow-ups keep the concept", () => {
  it('"explain it without jargon" inherits the previous turn concept', () => {
    const history: TurnMemory[] = [
      { intent: "confused", conceptId: "c_position", question: null, said: "I don't get positional encoding." },
    ];
    const draft = compileTranscript("Explain it without jargon.");
    expect(draft.conceptIds).toEqual([]);
    const plan = planTurn(draft, history, null);
    expect(plan.intent).toBe("explain");
    expect(plan.primaryConceptId).toBe("c_position");
    expect(plan.inherited).toBe(true);
  });

  it('"I do not understand it" is heard as confusion, not as a position', () => {
    const history: TurnMemory[] = [
      { intent: "note", conceptId: "c_position", question: null, said: "Positional encoding is in week 4." },
    ];
    const plan = planTurn(compileTranscript("I do not understand it at all."), history, null);
    expect(plan.intent).toBe("confused");
    expect(plan.primaryConceptId).toBe("c_position");
  });

  it('"quiz me on it" asks about the concept from the previous turn', () => {
    const history: TurnMemory[] = [
      { intent: "claim", conceptId: "c_qkv", question: null, said: "Queries and keys are compared." },
    ];
    const plan = planTurn(compileTranscript("Quiz me on it."), history, null);
    expect(plan.intent).toBe("quiz");
    expect(plan.primaryConceptId).toBe("c_qkv");
  });
});

describe("citations", () => {
  it("drops a chunk id the model invented and keeps the real one", () => {
    const grounded = groundReply(
      {
        right: "You have the comparison right.",
        wrong: "Order is what goes missing.",
        question: "What breaks if you shuffle the tokens?",
        citations: [
          { chunkId: "ch_totally_made_up_9", quote: "invented" },
          { chunkId: CHUNKS[0].id, quote: CHUNKS[0].text.slice(0, 40) },
        ],
        misconception: null,
        masterySignal: "flat",
        strategy: "probe",
      },
      CHUNKS
    );
    expect(grounded.citations.map((c) => c.chunkId)).toEqual([CHUNKS[0].id]);
  });

  it("a correction with no surviving citation says so instead of asserting it", () => {
    const grounded = groundReply(
      {
        right: null,
        wrong: "Your source says the opposite.",
        question: "Where did you read that?",
        citations: [{ chunkId: "ch_not_real_1", quote: "invented" }],
        misconception: "made up",
        masterySignal: "down",
        strategy: "contrast",
      },
      CHUNKS
    );
    expect(grounded.citations).toEqual([]);
    expect(grounded.wrong).toMatch(/can't find that in your source/i);
    expect(grounded.misconception).toBeNull();
    expect(composeReply(grounded).split(/\s+/).length).toBeLessThanOrEqual(90);
  });

  it("keeps the model reply when the citation resolves", async () => {
    setReasoningProvider(
      new StubProvider(() => ({
        right: "Attention does compare every token.",
        wrong: "Order is the thing lost without position.",
        question: "What changes if you shuffle the words?",
        citations: [{ chunkId: CHUNKS[0].id, quote: CHUNKS[0].text.slice(0, 60) }],
        misconception: null,
        masterySignal: "down",
        strategy: "contrast",
      }))
    );
    const plan = planTurn(compileTranscript("I think attention already knows word order."), [], null);
    const turn = await tutorReply({ course: COURSE, plan, text: "I think attention already knows word order.", history: [], chunks: CHUNKS, conceptName: "Positional information" });
    expect(turn.source).toBe("model");
    expect(turn.citedIds).toEqual([CHUNKS[0].id]);
    expect(turn.text).toContain("shuffle");
    expect(providerStatus().lastLatencyMs).not.toBeNull();
  });
});

describe("provider outage", () => {
  it("a dead provider still answers, from the heuristic path", async () => {
    setReasoningProvider(new DeadProvider());
    const plan = planTurn(compileTranscript("I don't understand positional encoding."), [], null);
    const turn = await tutorReply({ course: COURSE, plan, text: "I don't understand positional encoding.", history: [], chunks: CHUNKS, conceptName: "Positional information" });
    expect(turn.source).toBe("heuristic");
    expect(turn.text.length).toBeGreaterThan(0);
    expect(turn.text.toLowerCase()).not.toContain("error");
  });

  it("no provider configured is not an error either", async () => {
    setReasoningProvider(null);
    delete process.env.AI_PROVIDER;
    expect(providerStatus().configured).toBe(false);
    const plan = planTurn(compileTranscript("Explain positional encoding simply."), [], null);
    const turn = await tutorReply({ course: COURSE, plan, text: "Explain positional encoding simply.", history: [], chunks: CHUNKS, conceptName: "Positional information" });
    expect(turn.source).toBe("heuristic");
  });
});

describe("keyword floor", () => {
  const q = COURSE.examQuestions[0];
  const fullAnswer = q.requiredKeywords.join(" and ") + " all matter here.";

  it("an answer covering every required point is never graded incorrect", async () => {
    setReasoningProvider(
      new StubProvider(() => ({
        verdict: "incorrect",
        correctPoints: [],
        missingPoints: ["everything"],
        possibleMisconception: "the model is wrong about this",
        nextQuestion: "Say it again?",
        feedback: "That misses the point.",
      }))
    );
    const graded = await gradeAnswer({
      subject: COURSE.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer: fullAnswer,
      chunks: CHUNKS,
      baseline: { ...assessAnswer(q.id, fullAnswer, { courseId: COURSE.id }) },
    });
    expect(graded.gradedBy).toBe("model");
    expect(graded.verdict).toBe("correct");
    expect(graded.missingPoints).toEqual([]);
  });

  it("coverage grades it alone when the model is unavailable", async () => {
    setReasoningProvider(new DeadProvider());
    const graded = await gradeAnswer({
      subject: COURSE.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer: fullAnswer,
      chunks: CHUNKS,
      baseline: { ...assessAnswer(q.id, fullAnswer, { courseId: COURSE.id }) },
    });
    expect(graded.gradedBy).toBe("keywords");
    expect(graded.verdict).toBe("correct");
  });

  it("a partial answer can still be graded down by the model", async () => {
    setReasoningProvider(
      new StubProvider(() => ({
        verdict: "partial",
        correctPoints: ["You named attention."],
        missingPoints: ["order"],
        possibleMisconception: null,
        nextQuestion: "What is lost when you shuffle them?",
        feedback: "You named attention. The missing piece is order.",
      }))
    );
    const graded = await gradeAnswer({
      subject: COURSE.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer: "Attention compares tokens.",
      chunks: CHUNKS,
      baseline: { ...assessAnswer(q.id, "Attention compares tokens.", { courseId: COURSE.id }) },
    });
    expect(graded.verdict).toBe("partial");
    expect(graded.nextQuestion).toMatch(/\?/);
  });
});

describe("an open question wins", () => {
  const openQuestion = COURSE.examQuestions[0];

  it("a spoken answer is graded, not filed as a note", () => {
    const plan = planTurn(compileTranscript("It would lose the order of the words."), [], openQuestion);
    expect(plan.intent).toBe("answer");
  });

  it("asking for another question still asks for another question", () => {
    const plan = planTurn(compileTranscript("Quiz me again."), [], openQuestion);
    expect(plan.intent).toBe("quiz");
  });

  it("history reopens the question the last quiz turn asked", () => {
    const { openQuestion: reopened } = readHistory(
      [
        {
          id: "e1", userId: "u", sessionId: "s", courseId: COURSE.id, sourceId: null,
          createdAt: new Date().toISOString(), transcript: "quiz me", cleanedTranscript: "Quiz me.",
          origin: "typed", transcriptionConfidence: null, transcriptionLatencyMs: null,
          intent: "quiz_request", conceptIds: ["c_position"], primaryConceptId: "c_position",
          importance: 0.7, confusion: 0.3, confidenceSelfReport: null, sourceLocator: null,
          interpretationConfidence: 0.9, evidenceIds: [], requestedAction: "quiz", status: "responded",
        },
      ],
      COURSE
    );
    expect(reopened?.conceptId).toBe("c_position");
  });

  it("the whole loop over the route: quiz, then the answer moves mastery", async () => {
    setReasoningProvider(null);
    const asked = await studyTurn(post({ text: "Quiz me on positional encoding.", origin: "typed", subjectId: COURSE.id }));
    const quiz = (await asked.json()) as { turn: { intent: string; tutor: { text: string } } };
    expect(quiz.turn.intent).toBe("quiz");
    expect(quiz.turn.tutor.text).toMatch(/\?/);

    const answered = await studyTurn(post({ text: "It would lose the order of the words in the sequence.", origin: "typed", subjectId: COURSE.id }));
    const graded = (await answered.json()) as {
      turn: { intent: string; masteryDelta: Record<string, number> };
      assessment: { verdict: string } | null;
    };
    expect(graded.turn.intent).toBe("answer");
    expect(graded.assessment?.verdict).toBeTruthy();
    expect(Object.values(graded.turn.masteryDelta)[0]).not.toBe(0);
  });

  it("a declarative statement is checked, not answered with a shrug", async () => {
    setReasoningProvider(null);
    const res = await studyTurn(post({ text: "Self-attention is when every token compares itself to every other token.", origin: "typed", subjectId: COURSE.id }));
    const body = (await res.json()) as { turn: { intent: string; conceptIds: string[] } };
    expect(body.turn.intent).toBe("claim");
    expect(body.turn.conceptIds.length).toBeGreaterThan(0);
  });
});
