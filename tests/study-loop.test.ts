import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { setReasoningProvider } from "@/lib/ai/provider";
import { getCourse } from "@/lib/courses";
import { checkClaim } from "@/lib/tutor/claim";
import { MAX_ATTEMPTS } from "@/lib/tutor/respond";
import { POST as studyTurn } from "@/app/api/study/turn/route";
import { GET as learnerGet } from "@/app/api/learner/route";
import { GET as pathGet } from "@/app/api/learner/path/route";

/**
 * The study loop as a student meets it, over the real routes.
 *
 * Every case here is a defect the round-1 student judge found and could
 * reproduce in under a minute: a cold visitor told about study sessions they
 * never had, a false statement filed instead of caught, a quiz that allowed
 * exactly one attempt and no hint, the marking key printed above the retry
 * box, and a two-minute answer rejected as "text is required".
 */

let currentUser = "u_loop_default";

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: currentUser, kind: "demo" as const } }) };
});

const COURSE = getCourse("course_transformers_w4");

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-loop-"));
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
  currentUser = `u_loop_${tag}_${(n += 1)}`;
  return currentUser;
}

function say(text: string): NextRequest {
  return new NextRequest("http://localhost/api/study/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, origin: "typed", subjectId: COURSE.id, clientEventId: `c_${Math.random()}` }),
  });
}

type TurnBody = {
  turn: {
    intent: string;
    tutor: { text: string; citations: { chunkId: string; quote: string }[] };
    band: { conceptId: string; label: string } | null;
    quiz: { open: boolean; questionId: string | null; attemptsLeft: number; canRetry: boolean };
  };
  assessment: { verdict: string; missingPoints: string[]; fullAnswerCovers: string[] } | null;
  claim: { status: string; quote: string | null } | null;
  band: { conceptId: string; label: string } | null;
  delta: number | null;
};

const read = (res: Response) => res.json() as Promise<TurnBody>;

describe("a brand-new visitor is never told about a session they did not have", () => {
  it("GET /api/learner returns the subject's concepts and none of the learner's", async () => {
    freshUser("cold_learner");
    const res = await learnerGet(new NextRequest(`http://localhost/api/learner?subject=${COURSE.id}`));
    const body = (await res.json()) as {
      mastery: Record<string, unknown>;
      events: unknown[];
      concepts: unknown[];
      priors: Record<string, number>;
    };
    expect(res.status).toBe(200);
    expect(body.concepts.length).toBe(COURSE.concepts.length);
    expect(body.mastery).toEqual({});
    expect(body.events).toEqual([]);
    expect(body.priors).toEqual({});
  });

  it("GET /api/learner/path returns an empty plan, not an invented one", async () => {
    freshUser("cold_path");
    const res = await pathGet(new NextRequest(`http://localhost/api/learner/path?subject=${COURSE.id}`));
    const body = (await res.json()) as { path: unknown[]; basis: { events: number } };
    expect(body.path).toEqual([]);
    expect(body.basis.events).toBe(0);
  });
});

describe("a wrong claim is caught, not filed", () => {
  it("the softmax claim is contradicted with the line that disproves it", () => {
    const chunks = COURSE.sources.flatMap((s) => s.chunks).filter((c) => c.id.startsWith("ch_pos"));
    const check = checkClaim({
      claim: "Positional encoding is added to the attention weights after the softmax.",
      chunks,
      course: COURSE,
      conceptId: "c_position",
    });
    expect(check.status).toBe("contradicted");
    expect(check.lead).toMatch(/token embeddings/);
    expect(check.quote).toMatch(/added to the token embeddings/);
    expect(check.question).toBeTruthy();
  });

  it("a known trap is caught by name", () => {
    const chunks = COURSE.sources.flatMap((s) => s.chunks).filter((c) => c.id.startsWith("ch_bp"));
    const check = checkClaim({
      claim: "Backpropagation and gradient descent are the same thing.",
      chunks,
      course: COURSE,
      conceptId: "c_backprop",
    });
    expect(check.status).toBe("contradicted");
    expect(check.lead).toMatch(/chain rule|optimiser/);
  });

  it("denying the trap is not the same as repeating it", () => {
    const chunks = COURSE.sources.flatMap((s) => s.chunks).filter((c) => c.id.startsWith("ch_bp"));
    const check = checkClaim({
      claim: "Backpropagation is not the same thing as gradient descent.",
      chunks,
      course: COURSE,
      conceptId: "c_backprop",
    });
    expect(check.status).not.toBe("contradicted");
  });

  it("over the route: the reply leads with the contradiction and quotes the passage", async () => {
    freshUser("claim_route");
    const res = await studyTurn(say("Positional encoding is added to the attention weights after the softmax."));
    const body = await read(res);
    expect(body.claim?.status).toBe("contradicted");
    expect(body.turn.tutor.text).toMatch(/^Not quite/);
    expect(body.turn.tutor.text).toMatch(/token embeddings/);
    expect(body.turn.tutor.citations.length).toBeGreaterThan(0);
    // It is never answered with the paragraph a confusion gets.
    expect(body.turn.tutor.text).not.toMatch(/Stored as your current belief/);
    // The correction earns a question, and that question is now live.
    expect(body.turn.quiz.open).toBe(true);
  });
});

describe("a quiz stays open until it is cleared", () => {
  it("wrong answer, hint, then the right answer clears it", async () => {
    freshUser("quiz_loop");
    const asked = await read(await studyTurn(say("Quiz me on positional encoding.")));
    expect(asked.turn.intent).toBe("quiz");
    expect(asked.turn.quiz.open).toBe(true);

    const wrong = await read(await studyTurn(say("Because it makes the model faster.")));
    expect(wrong.turn.intent).toBe("answer");
    expect(wrong.assessment?.verdict).toBe("incorrect");
    // Still open, and the retry is offered on the wire.
    expect(wrong.turn.quiz.open).toBe(true);
    expect(wrong.turn.quiz.canRetry).toBe(true);
    expect(wrong.turn.quiz.attemptsLeft).toBe(MAX_ATTEMPTS - 1);

    const hinted = await read(await studyTurn(say("I'm stuck, give me a hint.")));
    expect(hinted.turn.intent).toBe("hint");
    expect(hinted.turn.tutor.text).not.toMatch(/^Noted/);
    expect(hinted.turn.tutor.text.length).toBeGreaterThan(20);
    // A nudge costs nothing.
    expect(hinted.delta ?? 0).toBe(0);
    expect(hinted.turn.quiz.open).toBe(true);

    const right = await read(
      await studyTurn(say("Without positional information self-attention is permutation-equivariant, so the model loses the order of the tokens."))
    );
    expect(right.turn.intent).toBe("answer");
    expect(right.assessment?.verdict).toBe("correct");
    expect(right.turn.quiz.open).toBe(false);
  });

  it("the answer key is sealed while the question is live and named once it closes", async () => {
    freshUser("quiz_key");
    await studyTurn(say("Quiz me on positional encoding."));
    const wrong = await read(await studyTurn(say("Because it makes the model faster.")));
    expect(wrong.assessment?.missingPoints).toEqual([]);
    expect(wrong.assessment?.fullAnswerCovers).toEqual([]);
    // Nothing in the reply hands over the words that would clear it.
    expect(wrong.turn.tutor.text).not.toMatch(/Expected:/);

    const right = await read(
      await studyTurn(say("Without positional information self-attention is permutation-equivariant, so the model loses the order of the tokens."))
    );
    expect(right.assessment?.fullAnswerCovers.length).toBeGreaterThan(0);
  });

  it("saying stop parks the question", async () => {
    freshUser("quiz_stop");
    await studyTurn(say("Quiz me on positional encoding."));
    const stopped = await read(await studyTurn(say("Stop.")));
    expect(stopped.turn.quiz.open).toBe(false);
    const after = await read(await studyTurn(say("What does multi-head attention do?")));
    expect(after.turn.intent).not.toBe("answer");
  });

  it("a question closes itself after the attempt cap rather than trapping the session", async () => {
    freshUser("quiz_cap");
    await studyTurn(say("Quiz me on positional encoding."));
    let last: TurnBody | null = null;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      last = await read(await studyTurn(say(`Because it makes the model faster, take ${i}.`)));
    }
    expect(last?.turn.quiz.open).toBe(false);
    expect(last?.assessment?.fullAnswerCovers.length).toBeGreaterThan(0);
  });
});

describe("what the student is shown is a band, not the accounting", () => {
  it("every turn that moves a concept returns the band it landed in", async () => {
    freshUser("band");
    const body = await read(await studyTurn(say("I don't understand why attention needs positional encoding.")));
    expect(body.band?.conceptId).toBe("c_position");
    expect(["Solid", "Getting there", "Shaky", "Mixed up", "Not yet"]).toContain(body.band?.label);
  });
});

describe("the turn endpoint takes what the recorder produces", () => {
  it("accepts a two-minute answer", async () => {
    freshUser("long_text");
    const res = await studyTurn(say("a".repeat(4000)));
    expect(res.status).toBe(200);
  });

  it("says what is actually wrong when the text is too long", async () => {
    freshUser("too_long");
    const res = await studyTurn(say("a".repeat(7000)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/text is required/);
    expect(body.error.message).toMatch(/shorter burst/);
  });
});

describe("a note points at the passage the reply actually used", () => {
  type WithEvent = TurnBody & {
    event: { intent: string; sourceLocator: { section: string | null; page: number | null } | null };
  };

  it("files the correction against the cited chunk, not the top retrieval hit", async () => {
    freshUser("locator");
    const body = (await read(
      await studyTurn(say("Positional encoding is added to the attention weights after the softmax."))
    )) as WithEvent;
    const cited = body.turn.tutor.citations[0]?.chunkId;
    expect(cited).toBeTruthy();
    const chunk = COURSE.sources.flatMap((s) => s.chunks).find((c) => c.id === cited);
    // The note used to take chunks[0] — a turn quoting p.11 filed a note saying
    // p.5, and a note is the artefact that outlives the screen it came from.
    expect(body.event.sourceLocator?.page).toBe(chunk?.locator.page);
    expect(body.event.sourceLocator?.section).toBe(chunk?.locator.section);
  });

  it("asking for a hint with nothing open is a process turn with no source line", async () => {
    freshUser("hint_cold");
    const body = (await read(await studyTurn(say("Give me a hint, I am stuck on this."))))  as WithEvent;
    expect(body.turn.intent).toBe("hint");
    expect(body.event.intent).toBe("hint");
    // Not filed against whatever retrieval returned, and it costs nothing.
    expect(body.event.sourceLocator).toBeNull();
    expect(body.turn.tutor.citations).toEqual([]);
    expect(body.delta === null || body.delta === 0).toBe(true);
  });
});
