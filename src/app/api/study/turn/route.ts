import { NextRequest } from "next/server";
import { z } from "zod";
import { compileTranscript } from "@/lib/compiler";
import { getCourse } from "@/lib/courses";
import { getStore, learnerDNA } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";
import { assessAnswer, gradeAnswer, verifyResponse } from "@/lib/tutor";
import { LEARNING_INTENT, confirmPlan, planTurn, readHistory, tutorReply } from "@/lib/tutor/respond";

const Body = z.object({
  // `transcript`/`inputKind`/`courseId` are the names the study screen posts
  // today; `text`/`origin`/`subjectId` are the names in the spec. Both work.
  text: z.string().min(1).max(2000).optional(),
  transcript: z.string().min(1).max(2000).optional(),
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
      clean: z.string().max(2000).nullable().optional(),
    })
    .optional(),
  selection: z.string().optional(),
  clientEventId: z.string().max(80).optional(),
});

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
  const raw = parsed.success ? parsed.data.text ?? parsed.data.transcript : undefined;
  if (!parsed.success || !raw) return done(err("BAD_REQUEST", "text is required.", false, 400));
  const input = parsed.data;
  const origin = input.origin ?? input.inputKind ?? "voice";
  const course = getCourse(input.subjectId ?? input.courseId);
  const asrConfidence = input.asr?.confidence ?? input.confidence ?? null;
  const asrLatency = input.asr?.requestTimeMs ?? input.latencyMs ?? null;
  const asrSession = input.asr?.sessionId ?? input.transcriptionSessionId ?? null;

  const store = getStore();
  await store.seedCourse(identity.userId, course.id);

  trace.start("plan");
  const draft = compileTranscript(raw, { selection: input.selection, hasActiveSource: true, courseId: course.id });
  const priorEvents = await store.listEvents(identity.userId, 30);
  const { memory, openQuestion } = readHistory(priorEvents, course);
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

  if (plan.intent === "answer" && plan.openQuestion) {
    const q = plan.openQuestion;
    const baseline = assessAnswer(q.id, raw, { courseId: course.id });
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
    question = graded.nextQuestion;
    text = [graded.feedback, question].filter(Boolean).join(" ");
    strategy = "recall";
    citedIds = graded.evidenceIds;
    citations = chunks.filter((c) => citedIds.includes(c.id)).slice(0, 2).map((c) => ({ chunkId: c.id, quote: c.text.slice(0, 160) }));
    assessment = graded.verdict;
    misconception = graded.possibleMisconception;
    source = graded.gradedBy === "model" ? "model" : "heuristic";
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
    confusion: plan.intent === "confused" ? 0.9 : draft.confusion,
    interpretationConfidence: draft.interpretationConfidence,
    evidenceIds: citedIds,
    requestedAction: draft.requestedAction,
    status: "responded",
    sourceLocator: chunks[0] ? { section: chunks[0].locator.section, page: chunks[0].locator.page } : null,
    assessment,
    masterySignal,
    hint: plan.openQuestion?.hint ?? null,
  });
  trace.end("persist");
  await store.saveTutorMessage(identity.userId, sessionId, "assistant", text, citedIds).catch(() => {});

  const events = await store.listEvents(identity.userId, 20);
  const masteryDelta: Record<string, number> =
    outcome.event.primaryConceptId && outcome.delta !== null ? { [outcome.event.primaryConceptId]: outcome.delta } : {};

  serverLog("study.turn", trace.id, {
    intent: plan.intent, source, cited: citedIds.length, timings: JSON.stringify(trace.timings()),
  });

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
    },
    // Same fields the study screen reads today, so nothing has to change at once.
    event: outcome.event,
    tutor,
    assessment: graded ? { ...graded, question: plan.openQuestion?.question ?? null } : null,
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
