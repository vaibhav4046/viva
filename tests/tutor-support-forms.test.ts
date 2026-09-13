import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { setReasoningProvider, type ReasoningProvider } from "@/lib/ai/provider";
import { compileTranscript } from "@/lib/compiler";
import { getCourse, type Course } from "@/lib/courses";
import { chunkPages, normalizeText } from "@/lib/intake/chunk";
import { extractSubjectBody } from "@/lib/intake/extract";
import { scoreChunks } from "@/lib/retrieval";
import { checkClaim, echoesClaim } from "@/lib/tutor/claim";
import { groundReply, planTurn } from "@/lib/tutor/respond";
import type { SourceChunk } from "@/lib/types";
import { POST as studyTurn } from "@/app/api/study/turn/route";

/**
 * A source is allowed to call a thing by more than one name.
 *
 * A student judge scored the build 6.5 and their worst instance was this: they
 * typed the definition of kcat almost out of their own pasted notes and were
 * answered "I could not check that against your source, so I will not tell you
 * it is right", citing the passage that ends with that sentence. Measured, the
 * refusal was one word in twelve — the notes write "The turnover number is the
 * number of substrate molecules converted…", the student wrote "kcat", and the
 * acronym counted as a word the line was missing.
 *
 * The alias half of that fix is what this file holds. The coverage bar it was
 * originally built on is gone: it forgave one claim word in five, which is
 * exactly what let a one-word antonym swap through, and the judge's own
 * sentence went with it because it reorders its line as well as renaming it.
 * That loss is measured and recorded on the first test below rather than
 * softened.
 *
 * The same week, better concept names out of pasted notes made the second half
 * of this worse rather than better. "Ordering invariant" became a term the
 * supporting line had to repeat verbatim, and the line says only "the
 * invariant", so a true sentence stopped being confirmed on the strength of an
 * improvement to intake.
 *
 * Both are the same rule: a claim's term is satisfied by a recognisable form of
 * itself — a name or alias the SUBJECT declares, or its head noun where the
 * line puts no other named thing of that kind. Nothing here invents a synonym.
 *
 * The four negatives are the whole reason the rule is shaped that way, and each
 * one killed a wider version that was written first:
 *
 *   - swapping "enzyme" and "substrate" in the judge's own sentence produces
 *     the same twelve words in the same passage, and must not be confirmed.
 *     What separates them is word ORDER, not vocabulary;
 *   - inverting the BST sentence likewise;
 *   - "Value iteration alternates policy evaluation and policy improvement" and
 *     "Gradient descent applies the chain rule…" were both CONFIRMED by a
 *     version that read "the line names the same concept" as "the line names
 *     the same thing". A subject may file two contrasting things under one
 *     concept — "Policy vs value iteration" lists both, "Backpropagation" lists
 *     "gradient descent" — so that reading is not available.
 */

let currentUser = "u_forms_default";

vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: currentUser, kind: "demo" as const } }) };
});

const ENZYME_NOTES = `Enzyme Kinetics

Enzymes are biological catalysts that speed up reactions by lowering the activation energy of the reaction. They are not consumed by the reaction and they do not change the position of the equilibrium. Enzyme catalysis depends on the active site, a pocket whose shape and chemistry are complementary to the transition state rather than to the free substrate.

The induced fit model says the active site is not a rigid lock. Binding of the substrate changes the shape of the enzyme slightly, and that change is what brings the catalytic groups into position. The older lock and key model treats the site as pre-formed and cannot explain why binding itself is productive.

Michaelis-Menten kinetics describes how the initial rate of an enzyme catalysed reaction depends on substrate concentration. At low substrate concentration the rate rises almost linearly, and at high substrate concentration the rate flattens off because every enzyme molecule is occupied. The curve is a rectangular hyperbola described by v equals Vmax times S over Km plus S.

The Michaelis constant Km is the substrate concentration at which the rate is exactly half of Vmax. A low Km means high affinity, because very little substrate is needed to reach half maximal velocity. A high Km means low affinity, because a lot of substrate is needed to reach the same point. Km has units of concentration and it does not depend on the amount of enzyme present.

The maximum rate Vmax is the rate reached when the enzyme is fully saturated with substrate. Vmax depends on how much enzyme is there, so it is not an intrinsic property of the enzyme. The turnover number kcat is Vmax divided by the total enzyme concentration. The turnover number is the number of substrate molecules converted to product per enzyme molecule per second when the enzyme is saturated.

The specificity constant kcat over Km measures how good an enzyme is with a particular substrate at low substrate concentration. It is the best single number for comparing two substrates, and its upper limit is set by how fast the enzyme and substrate can diffuse together.

The Lineweaver-Burk plot takes the reciprocal of both sides of the Michaelis-Menten equation, so a hyperbola becomes a straight line. On that plot the y intercept is one over Vmax and the x intercept is minus one over Km. It exaggerates the error on the points taken at low substrate concentration, which is why non linear fitting is preferred now.`;

const BST_NOTES = `Binary Search Trees and Balancing

A binary search tree stores keys so that every node's left subtree holds keys smaller than the node and every right subtree holds keys larger. That single ordering invariant is what makes lookup cheap: at each node you compare once and throw away half the remaining tree.

The height of the tree is therefore the only thing that matters for performance. Search, insert and delete all walk one root-to-leaf path, so they all cost O(h) where h is the height.

Checking only that each node is larger than its left child is not enough, because the invariant is about whole subtrees rather than immediate children. The correct validity check passes a min and max range down the recursion, and each node must lie strictly inside the range it inherits.

AVL trees keep the tree short by enforcing a strict balance condition: for every node, the heights of its two subtrees differ by at most one. A single rotation fixes an outside imbalance and a double rotation fixes an inside one. The AVL height bound is about 1.44 log n.`;

/** A subject built the way a student builds one: paste notes, study it. */
function fromNotes(notes: string, id: string, extra: { name: string; aliases: string[] }[] = []): { course: Course; chunks: SourceChunk[] } {
  const text = normalizeText(notes);
  const chunks = chunkPages([{ text }], id, "Your notes");
  const body = extractSubjectBody(chunks, text);
  expect(body).not.toBeNull();
  const concepts = [
    ...body!.concepts,
    ...extra.map((c, i) => ({ id: `c_x${i}`, name: c.name, aliases: c.aliases, description: c.name, chunkIds: chunks.map((x) => x.id) })),
  ];
  const course = {
    id: `course_${id}`, code: "TEST", title: "Notes", concepts,
    traps: [], examQuestions: [],
    sources: [{ id, title: "Your notes", type: "notes", chunks }],
  } as unknown as Course;
  return { course, chunks };
}

/** The chain /api/study/turn walks: compile → plan → retrieve → check. */
function check(subject: { course: Course; chunks: SourceChunk[] }, text: string) {
  const { course, chunks } = subject;
  const draft = compileTranscript(text, { concepts: course.concepts });
  const plan = planTurn(draft, [], null);
  const query = [draft.cleanedTranscript, course.concepts.find((c) => c.id === plan.primaryConceptId)?.name ?? ""].join(" ");
  const picked = scoreChunks(chunks, query, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
  return checkClaim({ claim: draft.cleanedTranscript, chunks: picked, course, conceptId: plan.primaryConceptId });
}

const ENZYME = fromNotes(ENZYME_NOTES, "src_enzyme");
// The concept name the intake lane started producing, and the reason a true
// sentence about it stopped being confirmed.
const BST = fromNotes(BST_NOTES, "src_bst", [{ name: "Ordering invariant", aliases: [] }]);
const TRANSFORMERS = getCourse("course_transformers_w4");
const T_CHUNKS = TRANSFORMERS.sources.flatMap((s) => s.chunks);

describe("the acronym a student's notes use is the term the passage names", () => {
  /*
   * The judge's own sentence, and the one confirmation this work gave back.
   *
   * It WAS confirmed, on the strength of covering 0.8 of its line's words. It
   * is not any more, and the reason is the same reason thirteen one-word
   * inversions stopped being confirmed on the same day: coverage counted the
   * claim's vocabulary and never its arrangement. This sentence reorders its
   * line — the notes read "…molecules converted to product per enzyme molecule
   * per second", the student wrote "…molecules one enzyme molecule converts to
   * product per second" — and it uses a word ("one") the line does not.
   *
   * That is a real loss and it is recorded rather than argued away: measured
   * over the shipped library, the same change cost 36 of 2,947 confirmations
   * and stopped 13 of 14 false ones. A miss is answered with "I could not
   * check that against your source"; the other way round told a student their
   * own notes agree that a low Km means low affinity. The alias half of the
   * fix — "kcat" being the name the line spells "turnover number" — is still
   * live and is what the second test here holds.
   */
  it("says so honestly on the judge's kcat sentence rather than agreeing", () => {
    const c = check(ENZYME, "kcat is the turnover number, the number of substrate molecules one enzyme molecule converts to product per second when it is saturated.");
    expect(c.status, c.lead ?? "").not.toBe("supported");
    expect(c.status, c.lead ?? "").not.toBe("contradicted");
  });

  it("still reads kcat as the thing the line calls the turnover number", () => {
    // Word for word off the page, with the acronym in place of the phrase.
    // If the alias resolution had gone with the coverage bar, this would be a
    // miss too, and the judge's complaint would be back in full.
    const c = check(ENZYME, "The turnover number kcat is Vmax divided by the total enzyme concentration.");
    expect(c.status, c.lead ?? "").toBe("supported");
    // A confirmation with nothing to show for it is a compliment, not a check.
    expect(c.quote).toBeTruthy();
    expect(c.chunkId).toBeTruthy();
  });

  it("refuses the same twelve words with enzyme and substrate swapped", () => {
    // Identical vocabulary, identical coverage. Only the word ORDER differs,
    // and that is the whole of what stops it.
    const c = check(ENZYME, "kcat is the turnover number, the number of enzyme molecules one substrate molecule converts to product per second when it is saturated.");
    expect(c.status, c.lead ?? "").not.toBe("supported");
  });
});

/**
 * The other five of the fourteen: a subject a student built five minutes ago
 * out of pasted notes, with one word of a line swapped for its opposite. All
 * five were confirmed on a running server on 13 Sep — "That matches Enzyme
 * Kinetics", quoting the line that says the reverse.
 *
 * A subject with no authored traps is where this matters most. There is no
 * course author here to have written the misconception down; the only thing
 * standing between the student and "That matches" is what the passage says.
 */
describe("one word swapped is never a match, on a subject built from notes", () => {
  const INVERTED: { id: string; subject: typeof ENZYME; text: string }[] = [
    { id: "low Km, low affinity", subject: ENZYME, text: "The Michaelis constant Km is the substrate concentration at which the rate is exactly half of Vmax. A low Km means low affinity, because very little substrate is needed to reach half maximal velocity." },
    { id: "kcat the other way up", subject: ENZYME, text: "The turnover number kcat is the total enzyme concentration divided by Vmax." },
    { id: "high Km, high affinity", subject: ENZYME, text: "A high Km means high affinity, because a lot of substrate is needed to reach the same point." },
    { id: "low Km, a lot of substrate", subject: ENZYME, text: "A low Km means high affinity, because a lot of substrate is needed to reach half maximal velocity." },
    { id: "AVL at least one", subject: BST, text: "AVL trees keep the tree short by enforcing a strict balance condition: for every node, the heights of its two subtrees differ by at least one." },
  ];

  for (const inv of INVERTED) {
    it(`never confirms "${inv.id}"`, () => {
      const c = check(inv.subject, inv.text);
      expect(c.status, `${c.lead ?? ""} ${c.quote ?? ""}`).not.toBe("supported");
    });
  }

  it("still confirms each of those lines the way the notes actually write them", () => {
    // The control. Every guard above is one word wide, so each needs the
    // unmodified sentence to prove it refuses the modified one for the right
    // reason and has not simply stopped confirming anything.
    for (const [subject, text] of [
      [ENZYME, "A low Km means high affinity, because very little substrate is needed to reach half maximal velocity."],
      [ENZYME, "A high Km means low affinity, because a lot of substrate is needed to reach the same point."],
      [BST, "AVL trees keep the tree short by enforcing a strict balance condition: for every node, the heights of its two subtrees differ by at most one."],
    ] as [typeof ENZYME, string][]) {
      expect(check(subject, text).status, text).toBe("supported");
    }
  });
});

describe("a source that writes “the invariant” is naming the ordering invariant", () => {
  it("confirms a true sentence about it", () => {
    const c = check(BST, "The ordering invariant is about whole subtrees, not immediate children.");
    expect(c.status, c.lead ?? "").toBe("supported");
    expect(c.quote).toBeTruthy();
    expect(c.chunkId).toBeTruthy();
  });

  it("refuses the inversion of that same sentence", () => {
    const c = check(BST, "The ordering invariant is about immediate children, not whole subtrees.");
    expect(c.status, c.lead ?? "").not.toBe("supported");
  });
});

describe("sameness of concept is not sameness of thing", () => {
  const cold = (text: string) => {
    const draft = compileTranscript(text, { concepts: TRANSFORMERS.concepts });
    const plan = planTurn(draft, [], null);
    const picked = scoreChunks(T_CHUNKS, draft.cleanedTranscript, { conceptIds: plan.conceptIds, limit: 3 }).map((r) => r.chunk);
    return checkClaim({ claim: draft.cleanedTranscript, chunks: picked, course: TRANSFORMERS, conceptId: plan.primaryConceptId });
  };

  // Both were confirmed by a version of this rule that read "the line names
  // the same concept" as "the line names the same thing".
  it("never confirms value iteration doing what policy iteration does", () => {
    const c = cold("Value iteration alternates policy evaluation and policy improvement.");
    expect(c.status, c.lead ?? "").not.toBe("supported");
  });

  it("never confirms gradient descent doing what backpropagation does", () => {
    const c = cold("Gradient descent applies the chain rule to compute the gradient of the loss with respect to every weight.");
    expect(c.status, c.lead ?? "").not.toBe("supported");
  });
});

describe("a correction has to correct something", () => {
  /*
   * Measured against the live provider, three cold runs out of three on
   * "Multi-head attention just runs the same attention twice to make it
   * faster" — false, and one the lexical checks are recorded as missing. Two
   * of the three came back *"It runs the same attention twice to make it
   * faster."* as VIVA's correction, with the map moving down: the product
   * asserting the misconception in its own voice while filing the learner as
   * wrong about it. The third was a real correction and must survive.
   */
  const CLAIM = "Multi-head attention just runs the same attention twice to make it faster.";

  it("reads the learner's own sentence back as no correction at all", () => {
    expect(echoesClaim("It runs the same attention twice to make it faster.", CLAIM)).toBe(true);
    expect(echoesClaim("Multi-head attention runs the same attention twice to make it faster.", CLAIM)).toBe(true);
  });

  it("keeps a correction that says something new", () => {
    // One new word is a correction. So is a denial, which reuses every word of
    // the claim on purpose and is the shape a ratio would throw away.
    expect(echoesClaim("Multi-head attention runs the same attention in parallel.", CLAIM)).toBe(false);
    expect(echoesClaim("It does not run the same attention twice.", CLAIM)).toBe(false);
    expect(echoesClaim("Self-attention lets a token look at all tokens, not just those before it.", CLAIM)).toBe(false);
    expect(echoesClaim(null, CLAIM)).toBe(false);
  });

  it("drops it from the reply rather than saying it", () => {
    const chunks = T_CHUNKS.slice(0, 1);
    const echoed = groundReply(
      {
        right: null,
        wrong: "It runs the same attention twice to make it faster.",
        question: "What does multi-head attention actually do?",
        citations: [{ chunkId: chunks[0].id, quote: chunks[0].text.slice(0, 80) }],
        misconception: "heads are a speed trick",
        masterySignal: "down",
        strategy: "contrast",
      },
      chunks,
      { said: CLAIM }
    );
    expect(echoed.wrong).toBeNull();
    // No correction means no misconception to file against them either.
    expect(echoed.misconception).toBeNull();
    expect(echoed.question).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * A sentence said past an open question is still read.
 * ------------------------------------------------------------------ */

class DeadProvider implements ReasoningProvider {
  readonly name = "dead-model";
  async generateText(): Promise<string> { throw new Error("provider unreachable"); }
  async generateObject<T>(): Promise<T> { throw new Error("provider unreachable"); }
}

/** Refutes whatever it is given, citing a passage it was actually shown. */
class RefutesAsides implements ReasoningProvider {
  readonly name = "refutes";
  async generateText(): Promise<string> { return ""; }
  async generateObject<T>(input: { user: string; schema: ZodType<T> }): Promise<T> {
    if (/First reading:/.test(input.user)) {
      return input.schema.parse({ intent: "claim", conceptIds: ["c_multihead"] });
    }
    const shown = /\[([A-Za-z0-9_:-]+)\]/.exec(input.user);
    return input.schema.parse({
      right: null,
      wrong: "The heads do not all learn the same thing; different heads specialise.",
      question: "Which head would you expect to track agreement?",
      citations: shown ? [{ chunkId: shown[1], quote: "Different heads specialise" }] : [],
      misconception: "heads are redundant copies",
      masterySignal: "down",
      strategy: "contrast",
    });
  }
}

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-forms-"));
  process.env.DATA_DIR = tmp;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => setReasoningProvider(null));

function say(text: string): NextRequest {
  return new NextRequest("http://localhost/api/study/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, subjectId: "course_transformers_w4", origin: "typed" }),
  });
}
const read = async (res: Response) => res.json();
function freshUser(tag: string): void { currentUser = `u_forms_${tag}_${Date.now()}`; }

describe("a false aside is refuted, not filed", () => {
  it("refutes it and hands the open question back", async () => {
    freshUser("aside");
    // The question opens on its own, the way it does for a learner, and only
    // then is the aside said. The sentence is one the lexical checks are
    // recorded as missing (`w03-mh-same-twice` in the claim corpus), so it
    // reaches the aside branch rather than the contradiction branch — which
    // is exactly the shape that used to be filed unread.
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    setReasoningProvider(new RefutesAsides());
    const body = await read(await studyTurn(say("Multi-head attention just runs the same attention twice to make it faster.")));

    // Still declines to mark it against a question it is not answering.
    expect(body.turn.tutor.text).toMatch(/not the question on the table|not an answer to the question/);
    expect(body.turn.tutor.text).toMatch(/The question still stands/);
    expect(body.assessment).toBeNull();
    expect(body.turn.quiz.open).toBe(true);
    expect(body.turn.quiz.attemptsUsed).toBe(0);
    // …and no longer lets the false half through unread.
    expect(body.turn.tutor.text).not.toMatch(/kept it as a note/);
    expect(body.turn.tutor.text).toMatch(/different heads specialise/i);
    expect(body.delta).toBeLessThan(0);
  });

  it("keeps saying so honestly when nothing can read it", async () => {
    // No provider: the correction has nothing to stand on, so the note line is
    // still what an honest answer looks like, and nothing moves.
    freshUser("aside-dead");
    setReasoningProvider(new DeadProvider());
    await studyTurn(say("quiz me"));
    const body = await read(await studyTurn(say("Multi-head attention runs several heads in parallel in each layer.")));

    expect(body.turn.tutor.text).toMatch(/kept it as a note/);
    expect(body.turn.tutor.text).toMatch(/The question still stands/);
    expect(body.delta).toBe(0);
    expect(body.turn.quiz.attemptsUsed).toBe(0);
  });
});
