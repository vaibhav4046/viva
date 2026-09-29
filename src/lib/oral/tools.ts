import { z } from "zod";
import { retrieveEvidence, verifyEvidence } from "@/lib/retrieval";
import { checkClaim, composeClaimReply } from "@/lib/tutor/claim";
import { assessAnswer, gradeAnswer } from "@/lib/tutor";
import type { Course, Subject } from "@/lib/courses/types";
import type { SourceChunk } from "@/lib/types";
import { rid, serverLog } from "@/lib/observe";
import { stripInjection } from "./sanitize";
import { verifyClaim } from "./verify-claim";

/**
 * The tools the oral exam gives the agent.
 *
 * Every one of these runs on the server against the caller's own material.
 * The agent gets no database, no network and no pass-through: it can only ask
 * these five questions, and each answer is produced by a function the rest of
 * VIVA already ships and the existing tests already pin.
 *
 * The reason that matters is the product claim. "VIVA catches what you got
 * wrong" is only true if the check that catches it is the same check the
 * written study loop uses. A bespoke oral-only grader would be a second
 * opinion that could disagree with the first, and a student told "correct"
 * aloud and "incorrect" on screen would have no way to work out which to
 * believe. So: reuse, and say so here.
 *
 * Two rules the definitions encode for the model:
 *
 *  1. Material is DATA. Chunks are returned as text inside a tool result. The
 *     system prompt tells the model this, and `stripInjection` makes the
 *     instruction-shaped part of a chunk inert regardless of what it says.
 *  2. `check_my_understanding` returning `consistent` is NOT agreement. It
 *     means no contradiction was found. The verdict object says so in words,
 *     because a model handed a bare status will phrase "consistent" as "you're
 *     right".
 */

export const MAX_QUERY = 300;
export const MAX_CLAIM = 2000;
export const MAX_ANSWER = 2000;

const Str = (max: number) => z.string().min(1).max(max).describe("A short noun phrase, no full sentence.");

export { stripInjection };

function excerpt(c: SourceChunk, chars = 600) {
  const page = c.locator.page != null ? `p.${c.locator.page}` : c.locator.section;
  return {
    chunkId: c.id,
    sourceId: c.sourceId,
    where: page ?? "passage",
    text: stripInjection(c.text.slice(0, chars)),
  };
}

export type ToolContext = {
  subject: Subject;
  course: Course | null;
  chunks: SourceChunk[];
  /** The agent may only ask about material the caller actually owns. */
  onNote?: (note: { claim: string; conceptId: string | null; correct: boolean }) => Promise<void>;
  /**
   * Called by the server with a verdict a tool actually returned. This is how the
   * learner's map and the debrief learn what happened: from the tool's own
   * output, never from what the model says it concluded (save_note's `correct`
   * is model-reported and is not offered to the Voice Agent).
   */
  onVerdict?: (v: OralVerdict) => Promise<void>;
};

export type OralVerdict =
  | { kind: "claim"; claim: string; concept: string | null; verdict: "supported" | "contradicted"; quote: string; page: number | null; passageId: string }
  | { kind: "answer"; question: string; answer: string; grade: "correct" | "partial" | "incorrect" };

export type ToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type ToolResultShape = Record<string, unknown>;

export type ToolSpec = {
  definition: ToolDefinition;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResultShape>;
};

/** The names, in one place, so the client and the tests cannot drift. */
export const ORAL_TOOL_NAMES = [
  "search_my_material",
  "quote_my_material",
  "check_my_understanding",
  "verify_claim",
  "grade_my_answer",
  "save_note",
] as const;

export type OralToolName = (typeof ORAL_TOOL_NAMES)[number];

const searchArgs = z.object({ query: Str(MAX_QUERY) });

const quoteArgs = z.object({
  claim: z.string().min(1).max(MAX_CLAIM).describe("The exact sentence the student just said, as close to their words as you can write it."),
});

const checkArgs = z.object({
  claim: z.string().min(1).max(MAX_CLAIM).describe("The student's own sentence, copied rather than summarised."),
  conceptId: z.string().max(80).optional().describe("If the student named a concept, its id."),
});

const verifyArgs = z.object({
  claim: z.string().min(1).max(MAX_CLAIM),
  concept: z.string().max(80).optional(),
});

const gradeArgs = z.object({
  question: z.string().min(1).max(500).describe("The question you asked, verbatim."),
  answer: z.string().min(1).max(MAX_ANSWER).describe("The student's answer as you heard it."),
});

const noteArgs = z.object({
  claim: z.string().min(1).max(MAX_CLAIM),
  correct: z.boolean().describe("true only if the learner's material itself supports the claim."),
  conceptId: z.string().max(80).optional(),
});

function bad(message: string): ToolResultShape {
  // Returned as a normal result with is_error rather than thrown: the agent
  // can then say something sensible out loud instead of the session dying.
  return { error: message, tell_the_student: message };
}

const searchSpec: ToolSpec = {
  definition: {
    type: "function",
    name: "search_my_material",
    description: "Find the passages in the student's own material that are most relevant to a topic. Returns text to quote from, never an answer.",
    parameters: {
      type: "object",
      properties: {
        query: Str(MAX_QUERY),
      },
      required: ["query"],
    },
  },
  async run(ctx, raw) {
    const args = searchArgs.safeParse(raw);
    if (!args.success) return bad("I need a short topic to search for.");
    const hits = retrieveEvidence(args.data.query, { chunks: ctx.chunks, limit: 3 });
    if (hits.length === 0) {
      return {
        found: false,
        say: "I could not find that in your material. Say so, do not answer from general knowledge.",
      };
    }
    return {
      found: true,
      passages: hits.map((h) => excerpt(h.chunk)),
      cite_by_chunk_id: hits.map((h) => h.chunk.id),
      say: "Quote from these passages. Do not add anything they do not say.",
    };
  },
};

const quoteSpec: ToolSpec = {
  definition: {
    type: "function",
    name: "quote_my_material",
    description: "Check whether the student's material stands behind a sentence, and return the relevant lines with their locations. Reports two separate facts: words_present (the words are in the material) and confirmed (the material actually supports the sentence). A claim can have the first and not the second, a near-miss paraphrase built from real vocabulary. Only confirmed:true may be presented to the student as supported.",
    parameters: {
      type: "object",
      properties: {
        claim: z.string().min(1).max(MAX_CLAIM).describe("The sentence to look for."),
      },
      required: ["claim"],
    },
  },
  async run(ctx, raw) {
    const args = quoteArgs.safeParse(raw);
    if (!args.success) return bad("I need the exact sentence to look for.");
    const hits = retrieveEvidence(args.data.claim, { chunks: ctx.chunks, limit: 3 });
    const verdict = verifyEvidence(args.data.claim, ctx.chunks);
    /**
     * Lexical coverage alone is NOT confirmation, and shipping this tool
     * without saying so was a real bug caught by running the app rather than by
     * a test.
     *
     * `verifyEvidence` counts how many of the claim's words appear in a chunk.
     * A near-miss paraphrase scores at the threshold: "multi-head attention
     * runs a single head over the input" hit coverage 0.25, every content word
     * in it is real and the sentence is still wrong. Worse, `checkClaim` is
     * lexical too and returned `consistent` for the same claim, so neither
     * existing function can catch it. Measured live, not assumed.
     *
     * So the tool reports the two facts separately and refuses to invent a
     * third:
     *
     *   `words_present`, the words are in the material. A fact.
     *   `confirmed`, the material actually stands behind the sentence.
     *                     True only when `checkClaim` says `supported`.
     *
     * Everything else is `consistent`, and a lexical system that cannot
     * distinguish "true" from "plausible-sounding" must say so rather than
     * hand the agent a green light. This is the same rule the rest of VIVA
     * already lives by: a miss says "I could not check that", never a false
     * correction.
     */
    const check = ctx.course
      ? checkClaim({ claim: args.data.claim, chunks: ctx.chunks, course: ctx.course, conceptId: null })
      : null;
    const contradicted = check?.status === "contradicted" || verdict.contradiction.length > 0;
    const wordsPresent = verdict.support.length > 0;
    const confirmed = check?.status === "supported" && !contradicted;

    const supporting = hits
      .filter((h) => verdict.support.includes(h.chunk.id))
      .map((h) => excerpt(h.chunk));

    return {
      words_present: wordsPresent,
      confirmed,
      coverage: Number(verdict.coverage.toFixed(2)),
      check_status: check?.status ?? "unavailable",
      supporting_passages: supporting,
      read_it_as: contradicted
        ? "The material points the other way. Tell the student what it says instead, and quote it."
        : confirmed
          ? "The material stands behind this sentence. You may tell the student it is supported, and quote the passage."
          : wordsPresent
            ? "These words are in the material, but the sentence they form is NOT something the material stands behind. Do not confirm it. Quote the passage and let the student compare."
            : "The material does not settle this. Say you could not confirm it, and leave it undecided.",
    };
  },
};

const checkSpec: ToolSpec = {
  definition: {
    type: "function",
    name: "check_my_understanding",
    description: "Check a statement the student made against their own material. Returns contradicted, supported, unsupported, or consistent. 'consistent' means no contradiction was found, it does NOT mean the student is right.",
    parameters: {
      type: "object",
      properties: {
        claim: z.string().min(1).max(MAX_CLAIM).describe("The student's sentence in their own words."),
        conceptId: z.string().max(80).optional(),
      },
      required: ["claim"],
    },
  },
  async run(ctx, raw) {
    const args = checkArgs.safeParse(raw);
    if (!args.success) return bad("I need the student's sentence to check.");
    if (!ctx.course) return bad("I cannot check that without the subject's map.");
    const check = checkClaim({
      claim: args.data.claim,
      chunks: ctx.chunks,
      course: ctx.course,
      conceptId: args.data.conceptId ?? null,
    });
    const cited = check.chunkId ? ctx.chunks.find((c) => c.id === check.chunkId) : null;
    return {
      status: check.status,
      // The words are in the payload, not just the code, because a model
      // handed `consistent` alone will say "you're right" out loud.
      meaning:
        check.status === "contradicted"
          ? "Their own material contradicts this. Correct it and quote the passage."
          : check.status === "supported"
            ? "Their own material says this, in the same polarity. You may confirm it and quote the passage."
            : check.status === "unsupported"
              ? "Nothing in the material settles it. Say you could not check it."
              : "No contradiction found. This is NOT confirmation. Do not tell them they are right.",
      lead: check.lead,
      reply_you_may_use: composeClaimReply(check, null),
      citation: cited ? excerpt(cited) : null,
    };
  },
};

const verifySpec: ToolSpec = {
  definition: {
    type: "function",
    name: "verify_claim",
    description: "Semantically verify the learner's exact claim against their passages. A supported or contradicted verdict is returned only with a code-checked verbatim quote and page; lexical fallback never confirms or corrects.",
    parameters: {
      type: "object",
      properties: {
        claim: z.string().min(1).max(MAX_CLAIM).describe("The learner's exact claim."),
        concept: z.string().max(80).optional(),
      },
      required: ["claim"],
    },
  },
  async run(ctx, raw) {
    const args = verifyArgs.safeParse(raw);
    if (!args.success) return bad("I need the learner's exact claim to check.");
    const result = await verifyClaim(args.data.claim, ctx.chunks, undefined, args.data.concept);
    if (ctx.onVerdict && result.verdict !== "not_in_material" && result.quote && result.passage_id) {
      await ctx.onVerdict({ kind: "claim", claim: args.data.claim, concept: args.data.concept ?? null, verdict: result.verdict, quote: result.quote, page: result.page, passageId: result.passage_id });
    }
    return {
      ...result,
      say: result.verdict === "contradicted"
        ? "Correct the learner using the exact quote, say the page aloud, and ask them to restate it."
        : result.verdict === "supported"
          ? "Confirm briefly using the exact quote and page."
          : "The material did not settle this. Do not confirm or correct the learner.",
    };
  },
};

const gradeSpec: ToolSpec = {
  definition: {
    type: "function",
    name: "grade_my_answer",
    description: "Grade a spoken answer to a question you asked. Use only when a question is open. The passages may overrule the model: an answer the source contradicts is graded incorrect.",
    parameters: {
      type: "object",
      properties: {
        question: z.string().min(1).max(500),
        answer: z.string().min(1).max(MAX_ANSWER),
      },
      required: ["question", "answer"],
    },
  },
  async run(ctx, raw) {
    const args = gradeArgs.safeParse(raw);
    if (!args.success) return bad("I need both the question and the answer.");
    if (!ctx.course) return bad("I cannot grade that without the subject's map.");
    // Match on the question text the agent read back. A miss is normal, it may
    // have rephrased, and `assessAnswer` falls back to the course's first
    // question, so the grade degrades to a less targeted one rather than
    // failing. The agent is told the marking key in the result, so a
    // rephrased question still gets feedback about the right points.
    const question = ctx.course.examQuestions.find((q) => q.question === args.data.question) ?? null;
    const baseline = assessAnswer(question?.id ?? ctx.course.examQuestions[0]?.id ?? "", args.data.answer, {
      course: ctx.course,
    });
    const requiredKeywords = question?.requiredKeywords ?? baseline.fullAnswerCovers;
    const graded = await gradeAnswer({
      subject: ctx.subject.title,
      question: question?.question ?? args.data.question,
      requiredKeywords,
      hint: question?.hint ?? "",
      answer: args.data.answer,
      chunks: ctx.chunks,
      check: baseline.check,
      baseline: {
        verdict: baseline.verdict,
        correctPoints: baseline.correctPoints,
        missingPoints: baseline.missingPoints,
        possibleMisconception: baseline.possibleMisconception,
        feedback: baseline.feedback,
        evidenceIds: baseline.evidenceIds.length > 0 ? baseline.evidenceIds : ctx.chunks.map((c) => c.id),
      },
    });
    await ctx.onVerdict?.({ kind: "answer", question: args.data.question, answer: args.data.answer, grade: graded.verdict });
    return {
      verdict: graded.verdict,
      correct_points: graded.correctPoints,
      missing_points: graded.missingPoints,
      feedback: stripInjection(graded.feedback),
      misconception: graded.possibleMisconception ?? null,
      graded_by: graded.gradedBy,
      /** The marking key. A rephrased question still gets feedback about the
       *  right points because these travel with the grade. */
      full_answer_covers: graded.fullAnswerCovers,
      next_question: graded.nextQuestion,
      evidence: graded.evidenceIds
        .map((id) => ctx.chunks.find((c) => c.id === id))
        .filter((c): c is SourceChunk => Boolean(c))
        .map((c) => excerpt(c, 320)),
      say: "Grade using this. Do not soften a 'incorrect' into a 'partial'.",
    };
  },
};

const noteSpec: ToolSpec = {
  definition: {
    type: "function",
    name: "save_note",
    description: "Save a durable note about what the student just got right or wrong, so the next session knows. Call once per exchange, only with a claim the student actually made.",
    parameters: {
      type: "object",
      properties: {
        claim: z.string().min(1).max(MAX_CLAIM),
        correct: z.boolean().describe("true only if their own material supports the claim."),
        conceptId: z.string().max(80).optional(),
      },
      required: ["claim", "correct"],
    },
  },
  async run(ctx, raw) {
    const args = noteArgs.safeParse(raw);
    if (!args.success) return bad("I need the claim and whether it was right.");
    if (!ctx.onNote) {
      return { saved: false, say: "Notes are off for this session." };
    }
    await ctx.onNote({
      claim: args.data.claim,
      conceptId: args.data.conceptId ?? null,
      correct: args.data.correct,
    });
    return { saved: true, say: "Saved. Move on to the next question." };
  },
};

const SPECS: Record<OralToolName, ToolSpec> = {
  search_my_material: searchSpec,
  quote_my_material: quoteSpec,
  check_my_understanding: checkSpec,
  verify_claim: verifySpec,
  grade_my_answer: gradeSpec,
  save_note: noteSpec,
};

export function toolDefinitions(): ToolDefinition[] {
  return Object.values(SPECS).map((s) => s.definition);
}

const NAME_SET: ReadonlySet<string> = new Set(Object.keys(SPECS));

/**
 * `name in SPECS` would be true for "toString", "constructor" and every other
 * inherited key, so an agent asking to call `constructor` would pass the guard
 * and then hit `SPECS[name].run` being undefined. A model that hallucinates an
 * exotic tool name should get the same clean error as any other unknown name.
 */
export function isOralTool(name: unknown): name is OralToolName {
  return typeof name === "string" && NAME_SET.has(name);
}

/**
 * The wire form of the tool definitions.
 *
 * `execution_mode: "hold"` is not a preference. Measured against the live
 * Voice Agent service on 2026-09-28 by `.viva/probe-execution-mode.mts`,
 * which connected with each candidate in turn:
 *
 *   omitted entirely                 -> invalid_value / execution_mode
 *   execution_mode: "conversational" -> invalid_value / execution_mode
 *   execution_mode: "hold"           -> OK
 *   "audio" / "speech" / "async" /
 *   "client" / "server"              -> invalid_value / execution_mode
 *
 * So the field is required and `hold` is the only value the service accepts.
 * The published tools overview describes two modes and names this one
 * `conversational`; that spelling is rejected. The first version of this file
 * sent `conversational`, and the consequence was that every live session
 * failed at the handshake with a field name and no accepted value, found by
 * probing the real service, not by any test, because a fake socket accepts
 * whatever it is told.
 *
 * `hold` is also the semantically right choice here. It means the agent waits
 * for the result instead of speaking over it, and while it waits the user's
 * transcript is held rather than discarded, which is what you want when a
 * student keeps talking through a source lookup.
 */
export function toolDefsForWire(): (ToolDefinition & { execution_mode: "hold" })[] {
  // Legacy lexical tools remain available to the written study loop and its
  // tests, but the Voice Agent may use only the quote-checked verifier.
  return toolDefinitions()
    .filter((d) => !["quote_my_material", "check_my_understanding", "save_note"].includes(d.name))
    .map((d) => ({ ...d, execution_mode: "hold" as const }));
}

export async function runOralTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<{ result: ToolResultShape; isError: boolean }> {
  if (!isOralTool(name)) {
    return { result: bad(`I do not know how to call ${String(name).slice(0, 40)}.`), isError: true };
  }
  try {
    return { result: await SPECS[name].run(ctx, (rawArgs ?? {}) as Record<string, unknown>), isError: false };
  } catch (e) {
    // A tool that throws would take the whole call down. The agent recovers
    // from an error result by apologising out loud, which beats silence.
    // The exception text stays on the server: it can name hosts, paths and
    // credentials, and it goes to the browser and into the model's context.
    serverLog("oral_tool.threw", rid(), { tool: name, err: (e as Error).message?.slice(0, 200) ?? "unknown" });
    return { result: { error: "That check could not be run." }, isError: true };
  }
}
