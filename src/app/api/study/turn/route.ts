import { NextRequest } from "next/server";
import { z } from "zod";
import { compileTranscript } from "@/lib/compiler";
import { resolveSubject } from "@/lib/courses/subject";
import { getStore, learnerDNA } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";
import { bandLabelFor } from "@/lib/mastery";
import { assessAnswer, gradeAnswer, sealAnswerKey, verifyResponse } from "@/lib/tutor";
import { checkClaim, composeClaimReply, sentencesOf, type ClaimCheck } from "@/lib/tutor/claim";
import { LEARNING_INTENT, MAX_ATTEMPTS, confirmPlan, planTurn, quizQuestionFor, readHistory, tutorReply } from "@/lib/tutor/respond";
import type { ExamQuestion } from "@/lib/courses";
import type { CompileDraft } from "@/lib/compiler";

/**
 * A two-minute answer is what the recorder allows and what a teach-it-back
 * actually runs to, so the turn endpoint has to accept one. At 2000 the
 * product could produce a transcript its own endpoint refused, and the refusal
 * came back as "text is required." — which was false, and sent the screen into
 * offering a retry on an input that could never succeed.
 */
const MAX_TEXT = 6000;

const Body = z.object({
  // `transcript`/`inputKind`/`courseId` are the names the study screen posts
  // today; `text`/`origin`/`subjectId` are the names in the spec. Both work.
  text: z.string().min(1).max(MAX_TEXT).optional(),
  transcript: z.string().min(1).max(MAX_TEXT).optional(),
  subjectId: z.string().max(80).optional(),
  courseId: z.string().max(80).optional(),
  origin: z.enum(["voice", "typed"]).optional(),
  inputKind: z.enum(["voice", "typed"]).optional(),
  confidence: z.number().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  transcriptionSessionId: z.string().nullable().optional(),
  asr: z
    .object({
      mode: z.enum(["dictation", "sync"]).nullable().optional(),
      confidence: z.number().nullable().optional(),
      requestTimeMs: z.number().nullable().optional(),
      audioMs: z.number().nullable().optional(),
      sessionId: z.string().nullable().optional(),
      clean: z.string().max(MAX_TEXT).nullable().optional(),
    })
    .optional(),
  selection: z.string().optional(),
  clientEventId: z.string().max(80).optional(),
});

/** Say what was actually wrong with the body, not "text is required." */
function bodyProblem(issues: { code: string; path: PropertyKey[] }[]): string {
  if (issues.some((i) => i.code === "too_big")) {
    return "That was longer than VIVA takes in one go — say it in a shorter burst.";
  }
  const field = issues[0]?.path.join(".") || "the request";
  if (issues.some((i) => i.code === "too_small")) return "There were no words in that.";
  return `That request was not shaped the way VIVA expects (${field}).`;
}

/**
 * POST /api/study/turn — one spoken (or typed) exchange.
 *
 * Words → first-pass reading → model confirmation → top-3 passages → grounded
 * reply (or a graded answer when a question is open) → mastery fold. The model
 * only ever proposes; passages, citations and every mastery number are decided
 * here and in `src/lib/mastery.ts`.
 */
export async function POST(req: NextRequest) {
  const trace = new Trace(rid());
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["compile", clientIp(req)]), "compile");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let body: unknown;
  try { body = await req.json(); } catch { return done(err("BAD_REQUEST", "Expected JSON.", false, 400)); }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return done(err("BAD_REQUEST", bodyProblem(parsed.error.issues), false, 400));
  const raw = parsed.data.text ?? parsed.data.transcript;
  if (!raw) return done(err("BAD_REQUEST", "There were no words in that.", false, 400));
  const input = parsed.data;
  const origin = input.origin ?? input.inputKind ?? "voice";
  const asrConfidence = input.asr?.confidence ?? input.confidence ?? null;
  const asrLatency = input.asr?.requestTimeMs ?? input.latencyMs ?? null;
  const asrSession = input.asr?.sessionId ?? input.transcriptionSessionId ?? null;

  const store = getStore();
  const course = await resolveSubject(store, identity.userId, input.subjectId ?? input.courseId);
  await store.seedCourse(identity.userId, course.id);

  trace.start("plan");
  const draft = compileTranscript(raw, { selection: input.selection, hasActiveSource: true, concepts: course.concepts });
  const priorEvents = await store.listEvents(identity.userId, 30);
  const { memory, openQuestion, open } = readHistory(priorEvents, course);
  let plan = planTurn(draft, memory, openQuestion);
  plan = await confirmPlan(plan, { text: draft.cleanedTranscript, course, history: memory });
  trace.end("plan");

  trace.start("retrieval");
  const concept = course.concepts.find((c) => c.id === plan.primaryConceptId) ?? null;
  const query = [draft.cleanedTranscript, input.selection ?? "", concept?.name ?? "", plan.openQuestion?.question ?? ""].join(" ");
  const retrieved = await store.retrieveEvidence(identity.userId, query, {
    sourceId: null, conceptIds: plan.conceptIds, limit: 3, courseId: course.id,
  });
  const chunks = retrieved.map((r) => r.chunk).filter((c) => /^[A-Za-z0-9_:-]+$/.test(c.id));
  trace.end("retrieval");

  // The two branches: grade an open question, or answer Socratically.
  trace.start("tutor");
  let text: string;
  let question: string | null;
  let strategy: string;
  let citedIds: string[];
  let citations: { chunkId: string; quote: string }[];
  let masterySignal: "up" | "down" | "flat" | null = null;
  let assessment: "correct" | "partial" | "incorrect" | null = null;
  let misconception: string | null = null;
  let source: "model" | "heuristic";
  let latencyMs: number | null = null;
  let graded: Awaited<ReturnType<typeof gradeAnswer>> | null = null;

  // What this turn asks, if it asks anything gradeable.
  let opensQuestion: ExamQuestion | null = null;
  let claimCheck: ClaimCheck | null = null;
  let closed = false;

  if (plan.intent === "answer" && plan.openQuestion) {
    const q = plan.openQuestion;
    const baseline = assessAnswer(q.id, raw, { course });
    graded = await gradeAnswer({
      subject: course.title,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
      answer: raw,
      chunks,
      baseline: {
        verdict: baseline.verdict,
        correctPoints: baseline.correctPoints,
        missingPoints: baseline.missingPoints,
        possibleMisconception: baseline.possibleMisconception,
        feedback: baseline.feedback,
        evidenceIds: baseline.evidenceIds.length > 0 ? baseline.evidenceIds : chunks.map((c) => c.id),
      },
    });
    // Cleared, or out of attempts: either way the question is finished, and
    // only now may the learner see what a full answer covers.
    closed = graded.verdict === "correct" || open.attempts + 1 >= MAX_ATTEMPTS;
    question = graded.nextQuestion;
    text = [graded.feedback, closed ? null : "Answer it again when you are ready.", question]
      .filter(Boolean)
      .join(" ");
    strategy = "recall";
    citedIds = graded.evidenceIds;
    citations = chunks.filter((c) => citedIds.includes(c.id)).slice(0, 2).map((c) => ({ chunkId: c.id, quote: c.text.slice(0, 160) }));
    assessment = graded.verdict;
    misconception = graded.possibleMisconception;
    source = graded.gradedBy === "model" ? "model" : "heuristic";
  } else if (plan.intent === "hint" && plan.openQuestion) {
    // The next-smallest nudge, and on a second ask the line it came from.
    // Never "Noted." — a stuck student saying so is the whole product working.
    const q = plan.openQuestion;
    const line = chunks[0] ? sentencesOf(chunks[0].text)[0] ?? null : null;
    const at = chunks[0]?.locator.page ? `p.${chunks[0].locator.page}` : chunks[0]?.locator.section ?? null;
    text = open.hintsUsed === 0 || !line
      ? q.hint
      : `${q.hint} ${at ? `${at} says: ` : "The passage says: "}“${line.slice(0, 200)}”`;
    question = q.question;
    strategy = "hint";
    citations = chunks.slice(0, 1).map((c) => ({ chunkId: c.id, quote: c.text.slice(0, 160) }));
    citedIds = citations.map((c) => c.chunkId);
    source = "heuristic";
  } else if (plan.stopped) {
    text = "Alright — that one is parked. Say what you want to look at instead.";
    question = null;
    strategy = "probe";
    citations = [];
    citedIds = [];
    source = "heuristic";
  } else if (plan.intent === "claim") {
    // S-1-03: a stated belief is checked against the passages before it is
    // filed. A wrong one is contradicted, with the line that disproves it.
    claimCheck = checkClaim({ claim: draft.cleanedTranscript, chunks, course, conceptId: plan.primaryConceptId });
    if (claimCheck.status === "contradicted") {
      text = composeClaimReply(claimCheck, concept?.name ?? null);
      question = claimCheck.question;
      strategy = "contrast";
      const cited = claimCheck.chunkId ? chunks.filter((c) => c.id === claimCheck?.chunkId) : chunks.slice(0, 1);
      citations = cited.map((c) => ({ chunkId: c.id, quote: c.text.slice(0, 160) }));
      citedIds = citations.map((c) => c.chunkId);
      assessment = "incorrect";
      misconception = claimCheck.lead;
      // The correction earns its question: the next turn grades the answer.
      opensQuestion = claimCheck.openQuestion;
      source = "heuristic";
    } else if (claimCheck.status === "unsupported") {
      text = composeClaimReply(claimCheck, concept?.name ?? null);
      question = claimCheck.question;
      strategy = "probe";
      citations = [];
      citedIds = [];
      opensQuestion = claimCheck.openQuestion;
      source = "heuristic";
    } else {
      const turn = await tutorReply({
        course, plan, text: draft.cleanedTranscript, history: memory, chunks,
        conceptName: concept?.name ?? null,
      });
      text = turn.text;
      question = turn.reply.question;
      strategy = turn.reply.strategy;
      citedIds = turn.citedIds;
      citations = turn.reply.citations;
      masterySignal = turn.reply.masterySignal;
      misconception = turn.reply.misconception;
      source = turn.source;
      latencyMs = turn.latencyMs;
    }
  } else {
    const turn = await tutorReply({
      course, plan, text: draft.cleanedTranscript, history: memory, chunks,
      conceptName: concept?.name ?? null,
    });
    text = turn.text;
    question = turn.reply.question;
    strategy = turn.reply.strategy;
    citedIds = turn.citedIds;
    citations = turn.reply.citations;
    masterySignal = turn.reply.masterySignal;
    misconception = turn.reply.misconception;
    source = turn.source;
    latencyMs = turn.latencyMs;
  }

  // Only a turn that asks a gradeable question opens one, and asking is the
  // only way a later sentence gets routed to the scorer.
  const asks = plan.intent === "quiz" || opensQuestion !== null;
  const requestedAction: CompileDraft["requestedAction"] =
    asks ? "quiz" : draft.requestedAction === "quiz" ? "none" : draft.requestedAction;
  // `plan.openQuestion` is the one that was already open; a quiz turn asks a
  // NEW one, picked the same way the reply picked it.
  const askedQuestion: ExamQuestion | null =
    plan.intent === "quiz" ? quizQuestionFor(course, plan.primaryConceptId) ?? null : opensQuestion;

  const userChunks = await store.getCourseChunks(identity.userId, course.id);
  const known = new Set(userChunks.map((c) => c.id));
  const v = verifyResponse(text, citedIds, known);
  if (!v.pass) text = v.repaired;
  trace.end("tutor");

  const sessionId = `sess_${trace.id}`;
  trace.start("persist");
  const outcome = await store.recordLearning(identity.userId, {
    idempotencyKey: input.clientEventId ?? `t_${trace.id}`,
    sessionId,
    courseId: course.id,
    sourceId: course.sources[0]?.id ?? null,
    transcript: raw,
    cleanedTranscript: draft.cleanedTranscript,
    origin,
    transcriptionConfidence: origin === "voice" ? asrConfidence : null,
    transcriptionLatencyMs: origin === "voice" ? asrLatency : null,
    transcriptionSessionId: origin === "voice" ? asrSession : null,
    intent: LEARNING_INTENT[plan.intent],
    conceptIds: plan.conceptIds,
    primaryConceptId: plan.primaryConceptId,
    importance: draft.importance,
    confusion: plan.intent === "confused" ? 0.9 : assessment === "incorrect" ? 0.6 : draft.confusion,
    interpretationConfidence: draft.interpretationConfidence,
    evidenceIds: citedIds,
    requestedAction,
    status: "responded",
    sourceLocator: chunks[0] ? { section: chunks[0].locator.section, page: chunks[0].locator.page } : null,
    assessment,
    masterySignal,
    hint: (askedQuestion ?? plan.openQuestion)?.hint ?? null,
  });
  trace.end("persist");
  await store.saveTutorMessage(identity.userId, sessionId, "assistant", text, citedIds).catch(() => {});

  const events = await store.listEvents(identity.userId, 20);
  const masteryDelta: Record<string, number> =
    outcome.event.primaryConceptId && outcome.delta !== null ? { [outcome.event.primaryConceptId]: outcome.delta } : {};

  serverLog("study.turn", trace.id, {
    intent: plan.intent, source, cited: citedIds.length, timings: JSON.stringify(trace.timings()),
  });

  // What the student is shown instead of a signed point delta.
  const movedConceptId = outcome.event.primaryConceptId;
  const band = movedConceptId
    ? { conceptId: movedConceptId, label: bandLabelFor(outcome.mastery[movedConceptId]) }
    : null;

  // The open-question state machine, spelled out for the screen: which
  // question is live, how many attempts are left, whether a retry is offered.
  const stillOpen: ExamQuestion | null = askedQuestion ?? (plan.stopped || closed ? null : plan.openQuestion);
  const attemptsUsed = askedQuestion ? 0 : assessment ? open.attempts + 1 : open.attempts;
  const quiz = {
    open: stillOpen !== null,
    questionId: stillOpen?.id ?? null,
    question: stillOpen?.question ?? null,
    attemptsUsed,
    attemptsLeft: stillOpen ? Math.max(0, MAX_ATTEMPTS - attemptsUsed) : 0,
    // Offered once an attempt exists and the question is still live — a caught
    // claim opens a question the learner has not tried yet, and asking for a
    // hint does not take the retry away.
    canRetry: stillOpen !== null && attemptsUsed > 0,
    canHint: stillOpen !== null,
  };

  const tutor = { text, question, citations, strategy, evidenceIds: citedIds, missingConcepts: [] as string[] };
  return done(Response.json({
    turn: {
      id: outcome.event.id,
      subjectId: course.id,
      userId: outcome.event.userId,
      at: outcome.event.createdAt,
      transcriptVerbatim: raw,
      transcriptClean: input.asr?.clean ?? null,
      usedText: input.asr?.clean ? "clean" : "verbatim",
      asr: {
        mode: input.asr?.mode ?? null,
        confidence: asrConfidence,
        requestTimeMs: asrLatency,
        audioMs: input.asr?.audioMs ?? null,
        sessionId: asrSession,
      },
      intent: plan.intent,
      conceptIds: plan.conceptIds,
      tutor,
      masteryDelta,
      misconception,
      band,
      quiz,
    },
    // Same fields the study screen reads today, so nothing has to change at once.
    event: outcome.event,
    tutor,
    assessment: graded
      ? sealAnswerKey({ ...graded, question: plan.openQuestion?.question ?? null }, closed)
      : null,
    quiz,
    band,
    claim: claimCheck
      ? { status: claimCheck.status, quote: claimCheck.quote, chunkId: claimCheck.chunkId }
      : null,
    verifier: { pass: v.pass, violations: v.violations },
    mastery: outcome.mastery,
    learner: learnerDNA(outcome.mastery, events.filter((e) => e.intent === "confusion").map((e) => e.id), events.length),
    masteryDelta,
    delta: outcome.delta,
    reason: outcome.reason,
    duplicate: outcome.duplicate,
    transcription: {
      transcript: raw,
      confidence: origin === "voice" ? asrConfidence : null,
      latencyMs: origin === "voice" ? asrLatency : null,
      sessionId: origin === "voice" ? asrSession : null,
      origin,
    },
    reasoning: { source, latencyMs },
    timings: trace.timings(),
    traceId: trace.id,
  }));
}
