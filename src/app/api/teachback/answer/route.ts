import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSubject } from "@/lib/courses/subject";
import { gradeAnswer, scoreTeachback } from "@/lib/tutor";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err, uid } from "@/lib/types";

const Body = z.object({
  conceptId: z.string().min(1).max(80),
  transcript: z.string().min(1).max(2000),
  clientEventId: z.string().max(80).optional(),
  courseId: z.string().max(80).optional(),
  subjectId: z.string().max(80).optional(),
});

function feedbackFor(
  verdict: "strong" | "developing" | "needs-work",
  hits: string[],
  misses: string[],
  total: number
): string {
  if (verdict === "strong") {
    return `Strong explanation — you covered ${hits.length} of ${total} key points${hits.length > 0 ? ` (${hits.join(", ")})` : ""}. Say it once more from memory to lock it in.`;
  }
  if (verdict === "developing") {
    return `Good progress — ${hits.length > 0 ? `you have ${hits.join(", ")}` : "you have the shape of it"} but still missing ${misses.slice(0, 4).join(", ")}. Focus your next attempt on the missing piece.`;
  }
  return `Good attempt — that is useful signal. Focus next on ${misses.slice(0, 4).join(", ")}.`;
}

/** POST /api/teachback/answer — score keyword coverage, fold into mastery. */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["tb-answer", clientIp(req)]), "exam");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let body: unknown;
  try { body = await req.json(); } catch { return done(err("BAD_REQUEST", "Expected JSON.", false, 400)); }
  const p = Body.safeParse(body);
  if (!p.success) return done(err("BAD_REQUEST", "conceptId and transcript (1-2000 chars) are required.", false, 400));

  const store = getStore();
  const course = await resolveSubject(store, identity.userId, p.data.subjectId ?? p.data.courseId);
  await store.seedCourse(identity.userId, course.id);
  const concepts = await store.getConcepts(identity.userId, course.id);
  const concept = concepts.find((c) => c.id === p.data.conceptId);
  if (!concept) return done(err("BAD_REQUEST", "Unknown conceptId.", false, 400));

  const required = course.teachback.keywords[p.data.conceptId] ?? [];
  const s = scoreTeachback(p.data.transcript, required);
  const hint = course.teachback.hints[p.data.conceptId]
    ?? course.examQuestions.find((q) => q.conceptId === p.data.conceptId)?.hint
    ?? `Explain ${concept.name} in your own words.`;

  // Coverage is the fallback and the floor; the model judges substance on top.
  const retrieved = await store.retrieveEvidence(identity.userId, `${concept.name} ${p.data.transcript}`, {
    sourceId: null, conceptIds: [p.data.conceptId], limit: 3, courseId: course.id,
  });
  const graded = await gradeAnswer({
    subject: course.title,
    question: `Teach it back: ${concept.name}.`,
    requiredKeywords: required,
    hint,
    answer: p.data.transcript,
    chunks: retrieved.map((r) => r.chunk),
    baseline: {
      verdict: s.verdict === "strong" ? "correct" : s.verdict === "developing" ? "partial" : "incorrect",
      correctPoints: s.hits,
      missingPoints: s.misses.slice(0, 4),
      possibleMisconception: null,
      feedback: feedbackFor(s.verdict, s.hits, s.misses, required.length),
      evidenceIds: retrieved.map((r) => r.chunk.id),
    },
  });
  const assessment = graded.verdict;

  const outcome = await store.recordLearning(identity.userId, {
    idempotencyKey: p.data.clientEventId ?? `teachback_${uid("e")}`,
    sessionId: `teachback_${Date.now().toString(36)}`,
    courseId: course.id,
    sourceId: course.sources[0]?.id ?? null,
    transcript: p.data.transcript,
    cleanedTranscript: p.data.transcript,
    origin: "voice",
    transcriptionConfidence: null,
    transcriptionLatencyMs: null,
    transcriptionSessionId: null,
    intent: "teachback",
    conceptIds: [p.data.conceptId],
    primaryConceptId: p.data.conceptId,
    importance: 0.8,
    confusion: assessment === "incorrect" ? 0.6 : 0.2,
    interpretationConfidence: 0.85,
    evidenceIds: [],
    requestedAction: "evaluate",
    status: "responded",
    sourceLocator: { section: "Teachback" },
    assessment,
    teachbackScore: s.coverage,
    hint,
  });

  return done(Response.json({
    coverage: s.coverage,
    score: s.score,
    verdict: graded.verdict,
    correctPoints: graded.correctPoints,
    missingPoints: graded.missingPoints,
    possibleMisconception: graded.possibleMisconception,
    nextQuestion: graded.nextQuestion,
    feedback: graded.feedback,
    mastery: outcome.mastery,
    delta: outcome.delta,
    reason: outcome.reason,
    duplicate: outcome.duplicate,
  }));
}
