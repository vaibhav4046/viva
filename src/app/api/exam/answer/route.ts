import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSubject } from "@/lib/courses/subject";
import { assessAnswer, gradeAnswer, sealAnswerKey } from "@/lib/tutor";
import { MAX_ATTEMPTS } from "@/lib/tutor/respond";
import { bandLabelFor } from "@/lib/mastery";
import type { LearningEvent } from "@/lib/types";
import { getStore, learnerDNA } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err, uid } from "@/lib/types";

const Body = z.object({
  questionId: z.string(),
  answer: z.string().min(1).max(2000),
  clientEventId: z.string().max(80).optional(),
  courseId: z.string().max(80).optional(),
  subjectId: z.string().max(80).optional(),
});

/**
 * Graded attempts already spent on this question, since the last time it was
 * cleared. One question gets `MAX_ATTEMPTS` tries; after that it closes and
 * the learner is told what a full answer covers.
 */
function attemptsSpent(events: LearningEvent[], conceptId: string): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.primaryConceptId !== conceptId || e.assessment == null) continue;
    if (e.assessment === "correct") break;
    n += 1;
  }
  return n;
}

/**
 * POST /api/exam/answer — spoken/typed answer → claim extraction → evidence →
 * assessment → atomic mastery update. Practice assessment only.
 */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["exam", clientIp(req)]), "exam");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let body: unknown;
  try { body = await req.json(); } catch { return done(err("BAD_REQUEST", "Expected JSON.", false, 400)); }
  const p = Body.safeParse(body);
  if (!p.success) return done(err("BAD_REQUEST", "questionId and answer required.", false, 400));
  const store = getStore();
  const course = await resolveSubject(store, identity.userId, p.data.subjectId ?? p.data.courseId);
  const q = course.examQuestions.find((x) => x.id === p.data.questionId);
  // Never score against the wrong question: unknown ids are caller errors, not Q1.
  if (!q) return done(err("UNKNOWN_QUESTION", "That question id is not part of this exam.", false, 400));
  await store.seedCourse(identity.userId, course.id);

  // Keyword coverage grades it first: that stands alone when the model is
  // unavailable, and it is the floor the model cannot grade below.
  const baseline = assessAnswer(q.id, p.data.answer, { course });
  const retrieved = await store.retrieveEvidence(identity.userId, `${q.question} ${p.data.answer}`, {
    sourceId: null, conceptIds: [q.conceptId], limit: 3, courseId: course.id,
  });
  const a = await gradeAnswer({
    subject: course.title,
    question: q.question,
    requiredKeywords: q.requiredKeywords,
    hint: q.hint,
    answer: p.data.answer,
    chunks: retrieved.map((r) => r.chunk),
    baseline: {
      verdict: baseline.verdict,
      correctPoints: baseline.correctPoints,
      missingPoints: baseline.missingPoints,
      possibleMisconception: baseline.possibleMisconception,
      feedback: baseline.feedback,
      evidenceIds: baseline.evidenceIds,
    },
  });
  const spent = attemptsSpent(await store.listEvents(identity.userId, 30), q.conceptId);
  // Cleared, or out of attempts: the question is finished either way, and the
  // marking key is only ever shown to a finished question. Printing "Expected:
  // order" above a live retry box makes the retry theatre.
  const closed = a.verdict === "correct" || spent + 1 >= MAX_ATTEMPTS;

  const outcome = await store.recordLearning(identity.userId, {
    idempotencyKey: p.data.clientEventId ?? `exam_${uid("e")}`,
    sessionId: `exam_${Date.now().toString(36)}`,
    courseId: course.id,
    sourceId: course.sources[0]?.id ?? null,
    transcript: p.data.answer,
    cleanedTranscript: p.data.answer,
    origin: "voice",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: "claim",
    conceptIds: [q.conceptId],
    primaryConceptId: q.conceptId,
    importance: 0.8,
    confusion: a.verdict === "incorrect" ? 0.6 : 0.2,
    interpretationConfidence: 0.85,
    evidenceIds: a.evidenceIds,
    requestedAction: "evaluate",
    status: "responded",
    sourceLocator: { section: "VIVA oral exam" },
    assessment: a.verdict === "correct" ? "correct" : a.verdict === "partial" ? "partial" : "incorrect",
    hint: q.hint,
  });
  await store.saveTutorMessage(identity.userId, outcome.event.sessionId, "assistant", a.feedback, a.evidenceIds).catch(() => {});
  const events = await store.listEvents(identity.userId, 20);

  return done(Response.json({
    ...sealAnswerKey(a, closed),
    mastery: outcome.mastery,
    learner: learnerDNA(outcome.mastery, events.filter((e) => e.intent === "confusion").map((e) => e.id), events.length),
    // The band is what the student is shown. The signed number stays here for
    // the record, and for the fold that produced it.
    band: { conceptId: q.conceptId, label: bandLabelFor(outcome.mastery[q.conceptId]) },
    closed,
    attemptsUsed: spent + 1,
    attemptsLeft: closed ? 0 : Math.max(0, MAX_ATTEMPTS - (spent + 1)),
    canRetry: !closed,
    delta: outcome.delta,
    reason: outcome.reason,
    duplicate: outcome.duplicate,
  }));
}
