import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { setReasoningProvider, type ReasoningProvider } from "@/lib/ai/provider";
import { COURSES, getCourse, type Course } from "@/lib/courses";
import { compileTranscript } from "@/lib/compiler";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim, trapTell } from "@/lib/tutor/claim";
import { assessAnswer, gradeAnswer, isFragmentAnswer, quotedHits } from "@/lib/tutor";
import { groundReply, planTurn } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";
import { POST as studyTurn } from "@/app/api/study/turn/route";

/**
 * The three things VIVA must never do, one describe block each.
 *
 * A student judge sat with the live site for an hour and filed all three as
 * blockers, and they are the same promise from three sides: VIVA never says a
 * thing is right that it has not checked, and never says a thing is wrong that
 * is not. Everything else in the product is downstream of the marking.
 *
 *   1. a correct sentence marked wrong, five cold runs out of five, because a
 *      trap fired on two nouns appearing together rather than on the claim;
 *   2. a false claim typed while a question was open, never checked at all,
 *      because the open question swallowed the turn;
 *   3. three typed nouns marked CORRECT, with a paragraph describing reasoning
 *      the learner had not done.
 *
 * The direction of error matters more than the rate. A miss says "I could not
 * check that"; a false positive tells a student who understands that they do
 * not, or hands a student who does not a pass. So the cases below are paired:
 * the mistake and its correct refutation, every time.
 */

let currentUser = "u_marking_default";

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: currentUser, kind: "demo" as const } }) };
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

const TRANSFORMERS = getCourse("course_transformers_w4");

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-marking-"));
  process.env.DATA_DIR = tmp;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => setReasoningProvider(null));

let n = 0;
function freshUser(tag: string): string {
  currentUser = `u_marking_${tag}_${(n += 1)}`;
  return currentUser;
}

function allChunks(course: Course): SourceChunk[] {
  return course.sources.flatMap((s) => s.chunks);
}

/** The same path /api/study/turn walks: compile → plan → retrieve → check. */
function cold(course: Course, text: string) {
  const draft = compileTranscript(text, { concepts: course.concepts });
  const plan = planTurn(draft, [], null);
  const query = [draft.cleanedTranscript, course.concepts.find((c) => c.id === plan.primaryConceptId)?.name ?? ""].join(" ");
  const chunks = scoreChunks(allChunks(course), query, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
  return checkClaim({ claim: draft.cleanedTranscript, chunks, course, conceptId: plan.primaryConceptId });
}

function say(text: string): NextRequest {
  return new NextRequest("http://localhost/api/study/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, origin: "typed", subjectId: TRANSFORMERS.id, clientEventId: `c_${Math.random()}` }),
  });
}

type TurnBody = {
  turn: { intent: string; tutor: { text: string }; quiz: { open: boolean; question: string | null; attemptsUsed: number; attemptsLeft: number } };
  assessment: { verdict: string; correctPoints: string[] } | null;
  claim: { status: string; quote: string | null } | null;
  delta: number | null;
};
const read = (res: Response) => res.json() as Promise<TurnBody>;

/* ------------------------------------------------------------------ *
 * 1. A correct statement must never score as a trap.
 * ------------------------------------------------------------------ */

describe("a trap fires on the claim, not on its topic", () => {
  // Typed cold, five times, five identical "Not quite —" replies, and the
  // correction handed the student their own sentence back.
  const backprop = [
    "Backpropagation and gradient descent are two different steps.",
    "Backpropagation computes the gradients and gradient descent uses them to update the weights.",
    "Backprop computes the direction and gradient descent, scaled by the learning rate, decides how far to move.",
  ];
  for (const text of backprop) {
    it(`leaves alone: "${text.slice(0, 46)}…"`, () => {
      expect(cold(TRANSFORMERS, text).status).not.toBe("contradicted");
    });
  }

  it("still catches the mistake the trap is actually about", () => {
    const check = cold(TRANSFORMERS, "Backpropagation is the same thing as gradient descent.");
    expect(check.status).toBe("contradicted");
    expect(check.quote).toBeTruthy();
  });

  it("every shipped trap has words that distinguish it from its own correction", () => {
    // Without them the only thing left to match on is the topic, which every
    // correct sentence about the topic also carries. A trap with an empty tell
    // cannot be told apart from agreement and must never fire.
    for (const course of Object.values(COURSES)) {
      for (const trap of course.traps) {
        expect(trapTell(trap).size, `${course.code} ${trap.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("no trap fires on its own correction, in any subject VIVA ships", () => {
    for (const course of Object.values(COURSES)) {
      const chunks = allChunks(course);
      for (const trap of course.traps) {
        const check = checkClaim({ claim: trap.correct, chunks, course, conceptId: trap.conceptId });
        expect(check.status, `${course.code} ${trap.id}`).not.toBe("contradicted");
      }
    }
  });
});

describe("VIVA may say a claim is right only when a line of the source says it", () => {
  it("quotes the passage that matches, rather than correcting it", () => {
    const check = cold(TRANSFORMERS, "A single attention head computes one weighted average, which bottlenecks what it can express.");
    expect(check.status).toBe("supported");
    expect(check.lead).toMatch(/^That matches p\.\d+/);
    expect(check.chunkId).toBeTruthy();
  });

  it("a denial of that same line is not a match for it", () => {
    // Every word but one is shared with the line that says the opposite.
    const check = cold(TRANSFORMERS, "Positional encodings are not added to the token embeddings.");
    expect(check.status).not.toBe("supported");
  });

  it("three nouns lifted out of a passage are not a claim it can confirm", () => {
    expect(cold(TRANSFORMERS, "order attention permutation").status).not.toBe("supported");
  });
});

/* ------------------------------------------------------------------ *
 * 2. An open question must not swallow the turn.
 * ------------------------------------------------------------------ */

describe("an open question does not stop VIVA reading what you said", () => {
  it("corrects a false claim typed while a question is open, and leaves the question open", async () => {
    freshUser("interrupt");
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    const body = await read(await studyTurn(say("The attention score is scaled by the square root of the number of heads.")));

    // The same correction the identical sentence gets cold, and p.7 with it.
    expect(body.claim?.status).toBe("contradicted");
    expect(body.turn.tutor.text).toMatch(/Before that —/);
    expect(body.turn.tutor.text).toMatch(/key dimension/);
    expect(body.turn.tutor.text).toMatch(/The question still stands/);
    // Never graded as an attempt at a question it was not answering.
    expect(body.assessment).toBeNull();
    expect(body.turn.quiz.open).toBe(true);
    expect(body.turn.quiz.attemptsUsed).toBe(0);
    expect(body.turn.quiz.attemptsLeft).toBe(3);
  });

  it("does not mark a true sentence about another concept against the open question", async () => {
    freshUser("elsewhere");
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    const body = await read(await studyTurn(say("Multi-head attention runs several heads in parallel in each layer.")));

    expect(body.assessment).toBeNull();
    expect(body.turn.tutor.text).toMatch(/not the question on the table/);
    expect(body.turn.tutor.text).toMatch(/The question still stands/);
    // Nothing was checked and nothing was graded, so the map does not move.
    expect(body.delta).toBe(0);
    expect(body.turn.quiz.open).toBe(true);
    expect(body.turn.quiz.attemptsUsed).toBe(0);
  });

  it("still grades an answer to the question that was asked", async () => {
    freshUser("answers");
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    const body = await read(await studyTurn(say("Without positional information the model cannot tell the order of the tokens.")));

    expect(body.assessment).not.toBeNull();
    expect(body.turn.quiz.attemptsUsed).toBeGreaterThan(0);
  });

  it("still grades a thin attempt that names none of the question's own words", async () => {
    // "because attention is permutation-equivariant" names neither
    // "positional" nor "order", and is still an attempt at the question.
    freshUser("thin");
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    const body = await read(await studyTurn(say("Because attention is permutation equivariant the tokens can be shuffled freely.")));
    expect(body.assessment).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Nothing is called right that was not checked.
 * ------------------------------------------------------------------ */

describe("keyword soup is never correct", () => {
  const soup = "order attention permutation";

  it("the keyword grader caps it at partial and asks for a sentence", () => {
    const a = assessAnswer("ex_pos_1", soup, { courseId: TRANSFORMERS.id });
    expect(a.verdict).not.toBe("correct");
    expect(a.feedback).toMatch(/say it as a sentence/i);
  });

  it("caps it on a question with a single required point too", () => {
    const a = assessAnswer("ex_pos_2", soup, { courseId: TRANSFORMERS.id });
    expect(a.verdict).not.toBe("correct");
  });

  it("the model cannot grade it correct either", async () => {
    setReasoningProvider(
      new StubProvider(() => ({
        verdict: "correct",
        correctPoints: ["you identified that a Transformer cannot distinguish the order of tokens"],
        missingPoints: [],
        possibleMisconception: null,
        nextQuestion: null,
        feedback: "Correct — you identified that without positional information a Transformer cannot distinguish order.",
      }))
    );
    const q = TRANSFORMERS.examQuestions[0];
    const graded = await gradeAnswer({
      subject: TRANSFORMERS.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer: soup,
      chunks: allChunks(TRANSFORMERS).slice(0, 3),
      baseline: { ...assessAnswer(q.id, soup, { courseId: TRANSFORMERS.id }) },
    });
    expect(graded.verdict).toBe("partial");
    expect(graded.feedback).toMatch(/say it as a sentence/i);
    // And the paragraph describing reasoning the learner never did is gone.
    expect(graded.correctPoints.join(" ")).not.toMatch(/identified|understand|captures/i);
  });

  it("a real sentence with the same words is still an answer", () => {
    expect(isFragmentAnswer("Order is lost.", ["order"])).toBe(false);
    expect(isFragmentAnswer("order and attention and permutation all matter here.", ["order", "attention", "permutation"])).toBe(false);
    expect(isFragmentAnswer("Without positional encodings attention is permutation-equivariant, so token order is lost.", ["order", "attention", "permutation"])).toBe(false);
    expect(isFragmentAnswer(soup, ["order"])).toBe(true);
  });
});

describe("credit is a quote of what the learner said", () => {
  it("names their own words, never a paraphrase of an understanding", () => {
    // Their spelling and their capitals: it is a quote, not a restatement.
    expect(quotedHits("Attention compares tokens.", ["order", "attention", "permutation"])).toEqual([
      'You said “Attention”.',
    ]);
  });

  it("says nothing at all when they landed nothing", () => {
    expect(quotedHits("It makes it faster.", ["order", "attention", "permutation"])).toEqual([]);
  });

  it("the model's own list of what was right never reaches the learner", async () => {
    setReasoningProvider(
      new StubProvider(() => ({
        verdict: "partial",
        correctPoints: ["you noted attention and permutation"],
        missingPoints: ["order"],
        possibleMisconception: null,
        nextQuestion: "What is lost when you shuffle them?",
        feedback: "Partly there.",
      }))
    );
    const q = TRANSFORMERS.examQuestions[0];
    const answer = "Positional information is necessary because bananas are yellow and the model eats them in order.";
    const graded = await gradeAnswer({
      subject: TRANSFORMERS.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer,
      chunks: allChunks(TRANSFORMERS).slice(0, 3),
      baseline: { ...assessAnswer(q.id, answer, { courseId: TRANSFORMERS.id }) },
    });
    expect(graded.correctPoints).not.toContain("you noted attention and permutation");
    for (const point of graded.correctPoints) expect(point).toMatch(/^You said “/);
  });
});

describe("the learner's own sentence is never handed back as VIVA's line", () => {
  const chunks = allChunks(TRANSFORMERS).slice(0, 3);
  const reply = {
    right: "AVL trees allow the two subtree heights to differ by at most two.",
    wrong: null,
    question: "What is the exact height-balance condition an AVL tree must satisfy?",
    citations: [{ chunkId: chunks[0].id, quote: chunks[0].text.slice(0, 40) }],
    misconception: null,
    masterySignal: "flat" as const,
    strategy: "probe" as const,
  };

  it("drops an affirmation nothing verified", () => {
    expect(groundReply(reply, chunks).right).toBeNull();
  });

  it("keeps the question, so the turn is still a tutor turn", () => {
    expect(groundReply(reply, chunks).question).toBe(reply.question);
  });

  it("keeps it only when the caller says a check confirmed it", () => {
    expect(groundReply(reply, chunks, { mayAffirm: true }).right).toBe(reply.right);
  });

  it("an unchecked claim says so instead, over the real route", async () => {
    freshUser("unchecked");
    setReasoningProvider(
      new StubProvider(() => ({
        right: "Backprop computes the direction and gradient descent decides how far to move.",
        wrong: null,
        question: "What does the learning rate control?",
        citations: [{ chunkId: "ch_bp_1", quote: "Backpropagation applies the chain rule" }],
        misconception: null,
        masterySignal: "up",
        strategy: "probe",
      }))
    );
    const body = await read(await studyTurn(say("Backprop computes the direction and gradient descent, scaled by the learning rate, decides how far to move.")));
    expect(body.claim?.status).toBe("consistent");
    expect(body.turn.tutor.text).toMatch(/could not check that against your source/);
    expect(body.turn.tutor.text).not.toMatch(/^Backprop computes the direction/);
    // A map that rises on a sentence VIVA just said it could not check is the
    // same unearned "you got it right", written as a number.
    expect(body.delta).toBe(0);
  });
});
