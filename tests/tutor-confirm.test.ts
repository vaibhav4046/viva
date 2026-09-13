import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { setReasoningProvider, type ReasoningProvider } from "@/lib/ai/provider";
import { compileTranscript } from "@/lib/compiler";
import { COURSES, getCourse, type Course } from "@/lib/courses";
import { CORPUS } from "@/lib/corpus";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim } from "@/lib/tutor/claim";
import { planTurn, tutorReply } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";
import { POST as studyTurn } from "@/app/api/study/turn/route";

/**
 * Telling a learner they are right — the promise, and what it costs to keep.
 *
 * A confirmation is the one thing VIVA says that a student cannot check for
 * themselves in the moment, so the bar is not "usually correct", it is "never
 * wrong". This file is the negative set for that bar: every sentence here is
 * false and none of them may come back as a match.
 *
 * Three of them were false confirmations on the shipped lexical check, found
 * by an adversarial pass over the library on 13 Sep and fixed in the same
 * change: a swapped number, and two hedges that reverse a sentence without
 * using a denial word. See `quantitiesAgree` and `HEDGED` in `claim.ts`.
 *
 * The rest are the set a paraphrase-confirming path would have to survive.
 * One such path — the model nominating the supporting line, the server
 * checking the nomination — was built against this file and did not survive
 * it; the counter-examples are recorded in `claim.ts` above `matchesLead` and
 * the two of them that matter most are pinned here so the next attempt meets
 * them on the first run rather than the fifth.
 */

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: "u_confirm", kind: "demo" as const } }) };
});

const TRANSFORMERS = getCourse("course_transformers_w4");
const POS = TRANSFORMERS.sources.flatMap((s) => s.chunks).find((c) => c.id === "ch_pos_1")!;

function subjectOf(id: string): Course {
  return (COURSES[id as keyof typeof COURSES] as Course | undefined) ?? (CORPUS as Course[]).find((c) => c.id === id)!;
}

type Probe = { id: string; courseId: string; text: string };

/** The route's own chain, minus persistence: plan, retrieve, check, answer. */
async function answer(probe: Probe): Promise<{ text: string; confirmed: boolean }> {
  const course = subjectOf(probe.courseId);
  const draft = compileTranscript(probe.text, { hasActiveSource: true, concepts: course.concepts });
  const plan = planTurn(draft, [], null);
  const concept = course.concepts.find((c) => c.id === plan.primaryConceptId) ?? null;
  const pool = course.sources.flatMap((s) => s.chunks);
  const query = [draft.cleanedTranscript, "", concept?.name ?? "", ""].join(" ");
  const chunks = scoreChunks(pool, query, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
  const check = checkClaim({ claim: draft.cleanedTranscript, chunks, course, conceptId: plan.primaryConceptId });
  if (check.status !== "consistent") return { text: check.lead ?? "", confirmed: check.status === "supported" };
  const turn = await tutorReply({
    course, plan, text: draft.cleanedTranscript, history: [], chunks,
    conceptName: concept?.name ?? null, unchecked: true,
  });
  return { text: turn.text, confirmed: false };
}

const FALSE_CLAIMS: Probe[] = [
  // f1 to f3 are a student judge's own inventions, typed on 13 Sep.
  { id: "f1", courseId: "course_transformers_w4", text: "an attention weight is the number of tokens in the batch divided by the weight of the document" },
  { id: "f2", courseId: "course_transformers_w4", text: "multi head attention means you run the whole transformer eight times and average the eight outputs" },
  { id: "f3", courseId: "course_os_immune", text: "the lymphatic system pumps blood around the body using the heart" },
  { id: "f4", courseId: "course_transformers_w4", text: "positional encodings are not added to the token embeddings" },
  { id: "f5", courseId: "course_transformers_w4", text: "backpropagation is the thing that picks the learning rate" },
  { id: "f6", courseId: "course_transformers_w4", text: "the attention score between two tokens is scaled by the number of heads in the layer" },
  { id: "f7", courseId: "course_transformers_w4", text: "self attention is not permutation equivariant even without any positional information" },
  { id: "f8", courseId: "course_transformers_w4", text: "gradient descent computes the gradients and backpropagation decides how far to step" },
  { id: "f9", courseId: "course_os_heart", text: "the human heart is located in the abdominal cavity below the diaphragm" },
  { id: "f10", courseId: "course_os_heart", text: "the apex of the heart is its superior tip and it lies to the right of the sternum" },
  // f11 and f12 were CONFIRMED by the shipped lexical check before this change:
  // a unit swap and a value swap, each one token away from the line they were
  // matched against, against a bar that forgives one word in five.
  { id: "f11", courseId: "course_os_heart", text: "each of the major pumping chambers ejects about 70 litres of blood per contraction" },
  { id: "f12", courseId: "course_os_heart", text: "Each of the major pumping chambers of the heart ejects approximately 700 mL blood per contraction in a resting adult." },
  // f13 and f14 were confirmed too: a hedge reverses the sentence and `DENIAL`
  // cannot see it, so the polarity guard read them as agreeing with the line.
  { id: "f13", courseId: "course_os_phys", text: "Friction is a force that rarely opposes the motion past each other of objects that are touching." },
  { id: "f14", courseId: "course_os_phys", text: "Friction is a force that fails to oppose the motion past each other of objects that are touching." },
  { id: "f15", courseId: "course_os_immune", text: "lymph is the term for blood plasma once it has entered the lymphatic ducts" },
  { id: "f16", courseId: "course_os_immune", text: "the lymphatic system moves lymph with its own muscular pump the way the heart moves blood" },
  { id: "f17", courseId: "course_os_immune", text: "lymph nodes are found only inside the brain and nowhere else in the body" },
  { id: "f18", courseId: "course_transformers_w4", text: "a single attention head computes eight different weighted averages at once" },
  // f19 and f20 are the two that killed the nomination path. Both are on the
  // subject's topic, both share its vocabulary, and for both the line that
  // states the opposite is in the retrieved set and reads as agreement to
  // anything short of a check that understands the sentence.
  { id: "f19", courseId: "course_os_econ", text: "Demand is the total quantity of a good that producers are willing to sell at each price." },
  { id: "f20", courseId: "course_os_alg", text: "In a relation, the domain is the set of the second components of each ordered pair." },
];

describe("no false sentence is ever answered with a match", () => {
  for (const probe of FALSE_CLAIMS) {
    it(`never confirms ${probe.id}`, async () => {
      const out = await answer(probe);
      expect(out.confirmed, out.text).toBe(false);
      expect(out.text, out.text).not.toMatch(/That matches/i);
    });
  }
});

describe("the two guards those failures bought, at the unit", () => {
  const heart = subjectOf("course_os_heart");
  const phys = subjectOf("course_os_phys");
  const chunksOf = (c: Course) => c.sources.flatMap((s) => s.chunks);
  const status = (course: Course, claim: string) => {
    const picked = scoreChunks(chunksOf(course), claim, { limit: 3 }).map((r) => r.chunk);
    return checkClaim({ claim, chunks: picked, course, conceptId: null }).status;
  };

  it("still confirms the sentence the passage actually contains", () => {
    // The control: both guards are one token wide, so each needs the
    // unmodified sentence to prove it refuses the modified one for the right
    // reason and has not simply broken the check.
    expect(status(heart, "Each of the major pumping chambers of the heart ejects approximately 70 mL blood per contraction in a resting adult.")).toBe("supported");
    expect(status(phys, "For now, we will define friction as a force that opposes the motion past each other of objects that are touching.")).toBe("supported");
  });

  it("refuses it once the number changes", () => {
    expect(status(heart, "Each of the major pumping chambers of the heart ejects approximately 700 mL blood per contraction in a resting adult.")).not.toBe("supported");
    expect(status(heart, "Each of the major pumping chambers of the heart ejects approximately 70 litres of blood per contraction in a resting adult.")).not.toBe("supported");
  });

  it("refuses it once a hedge reverses it", () => {
    for (const hedge of ["rarely opposes", "seldom opposes", "hardly opposes", "fails to oppose"]) {
      const claim = `For now, we will define friction as a force that ${hedge} the motion past each other of objects that are touching.`;
      expect(status(phys, claim), claim).not.toBe("supported");
    }
  });
});

/* ------------------------------------------------------------------ *
 * The other half of the brief: a true sentence must not be answered as
 * if it were a mistake.
 * ------------------------------------------------------------------ */

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-confirm-"));
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

class Corrects implements ReasoningProvider {
  readonly name = "corrects";
  constructor(private readonly wrong: string) {}
  async generateText(): Promise<string> { return ""; }
  async generateObject<T>(input: { user: string; schema: ZodType<T> }): Promise<T> {
    if (/First reading:/.test(input.user)) return input.schema.parse({ intent: "claim", conceptIds: ["c_position"] });
    return input.schema.parse({
      right: null,
      wrong: this.wrong,
      question: "What would change if you left them out?",
      citations: [{ chunkId: POS.id, quote: POS.text.slice(0, 120) }],
      misconception: null,
      masterySignal: "flat",
      strategy: "probe",
    });
  }
}

const TRUE_CLAIM =
  "positional encodings are added to the token embeddings so the model can tell which token came first";

describe("a gap is asked for, not held against them", () => {
  for (const opener of [
    "You didn't mention that the encodings can be learned as well as sinusoidal.",
    "You omitted that the encodings can be learned as well as sinusoidal.",
    "You failed to mention that the encodings can be learned as well as sinusoidal.",
  ]) {
    it(`rewrites "${opener.slice(0, 18)}…"`, async () => {
      setReasoningProvider(new Corrects(opener));
      const res = await studyTurn(post({ text: TRUE_CLAIM, subjectId: "course_transformers_w4", origin: "typed" }));
      const body = await res.json();
      expect(body.tutor.text).not.toMatch(/you did ?n'?t mention|you omitted|you failed to/i);
      expect(body.tutor.text).toMatch(/Still to add: the encodings can be learned/);
    });
  }

  it("leaves a real correction alone", async () => {
    setReasoningProvider(new Corrects("The score is scaled by the square root of the key dimension, not the head count."));
    const res = await studyTurn(post({ text: TRUE_CLAIM, subjectId: "course_transformers_w4", origin: "typed" }));
    const body = await res.json();
    expect(body.tutor.text).toContain("The score is scaled by the square root of the key dimension");
    expect(body.tutor.text).not.toMatch(/Still to add/);
  });
});
