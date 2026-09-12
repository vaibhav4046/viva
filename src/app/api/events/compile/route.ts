import { NextRequest } from "next/server";
import { z } from "zod";
import { compileTranscript } from "@/lib/compiler";
import { tutorRespond, verifyResponse } from "@/lib/tutor";
import { getCourse } from "@/lib/courses";
import { getStore, learnerDNA } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";

const Body = z.object({
  transcript: z.string().min(1).max(2000),
  inputKind: z.enum(["voice", "typed"]).default("voice"),
  confidence: z.number().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  transcriptionSessionId: z.string().nullable().optional(),
  selection: z.string().optional(),
  clientEventId: z.string().max(80).optional(),
  courseId: z.string().max(80).optional(),
});

/**
 * POST /api/events/compile — transcript + active context → validated
 * LearningEvent → evidence → tutor → verifier → atomic mastery update.
 * Idempotent on clientEventId (§23): network retries never duplicate Marks.
 */
export async function POST(req: NextRequest) {
  const trace = new Trace(rid());
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  // Keyed on IP, not identity: the demo cookie is client-resettable.
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
  if (!parsed.success) return done(err("BAD_REQUEST", "transcript is required.", false, 400));
  const { transcript, inputKind, confidence, latencyMs, transcriptionSessionId, selection, clientEventId } = parsed.data;
  const course = getCourse(parsed.data.courseId);

  trace.start("compile");
  // HARNESS A — compiler (never teaches, only interprets).
  const draft = compileTranscript(transcript, { selection, hasActiveSource: true, courseId: course.id });
  trace.end("compile");

  const store = getStore();
  await store.seedCourse(identity.userId, course.id);

  trace.start("retrieval");
  // No source pin: the merged pool (seeded course + caller uploads) is searched.
  const retrieved = await store.retrieveEvidence(identity.userId, draft.cleanedTranscript + " " + (selection ?? ""), {
    sourceId: null, conceptIds: draft.conceptIds, limit: 3, courseId: course.id,
  });
  trace.end("retrieval");
  // Evidence ids are server-generated; reject anything malformed anyway.
  const evidenceIds = retrieved.map((r) => r.chunk.id).filter((id) => /^[A-Za-z0-9_:-]+$/.test(id));
  const concept = course.concepts.find((c) => c.id === draft.primaryConceptId) ?? null;

  const sessionId = `sess_${trace.id}`;
  trace.start("persist");
  const outcome = await store.recordLearning(identity.userId, {
    idempotencyKey: clientEventId ?? `c_${trace.id}`,
    sessionId,
    courseId: course.id,
    sourceId: course.sources[0]?.id ?? null,
    transcript,
    cleanedTranscript: draft.cleanedTranscript,
    origin: inputKind,
    transcriptionConfidence: inputKind === "voice" ? (confidence ?? null) : null,
    transcriptionLatencyMs: inputKind === "voice" ? (latencyMs ?? null) : null,
    transcriptionSessionId: inputKind === "voice" ? (transcriptionSessionId ?? null) : null,
    intent: draft.intent,
    conceptIds: draft.conceptIds,
    primaryConceptId: draft.primaryConceptId,
    importance: draft.importance,
    confusion: draft.confusion,
    interpretationConfidence: draft.interpretationConfidence,
    evidenceIds,
    requestedAction: draft.requestedAction,
    status: "grounded",
    sourceLocator: retrieved[0]
      ? { section: retrieved[0].chunk.locator.section, page: retrieved[0].chunk.locator.page }
      : null,
  });
  trace.end("persist");

  // HARNESS D — tutor, then HARNESS E — verifier (1 repair).
  // knownIds come from the caller's own chunks: uploaded evidence must verify too.
  trace.start("tutor");
  const jargonFree = /without jargon|simply|simple/i.test(transcript);
  let t = tutorRespond({
    intent: outcome.event.intent, cleanedTranscript: outcome.event.cleanedTranscript,
    conceptName: concept?.name ?? null, conceptId: concept?.id ?? null,
    evidenceIds, jargonFree,
    mastery: outcome.event.primaryConceptId ? outcome.mastery[outcome.event.primaryConceptId]?.mastery : undefined,
    courseId: course.id,
  });
  const userChunks = await store.getCourseChunks(identity.userId, course.id);
  const known = new Set(userChunks.map((c) => c.id));
  const v = verifyResponse(t.text, t.evidenceIds, known);
  if (!v.pass) t = { ...t, text: v.repaired };
  trace.end("tutor");
  await store.saveTutorMessage(identity.userId, sessionId, "assistant", t.text, t.evidenceIds).catch(() => {});

  const events = await store.listEvents(identity.userId, 20);
  serverLog("compile.completed", trace.id, {
    intent: outcome.event.intent, duplicate: outcome.duplicate,
    evidence: evidenceIds.length, timings: JSON.stringify(trace.timings()),
  });

  return done(Response.json({
    event: outcome.event,
    tutor: t,
    verifier: { pass: v.pass, violations: v.violations },
    mastery: outcome.mastery,
    learner: learnerDNA(outcome.mastery, events.filter((e) => e.intent === "confusion").map((e) => e.id), events.length),
    delta: outcome.delta,
    reason: outcome.reason,
    duplicate: outcome.duplicate,
    transcription: {
      transcript, confidence: inputKind === "voice" ? (confidence ?? null) : null,
      latencyMs: inputKind === "voice" ? (latencyMs ?? null) : null,
      sessionId: inputKind === "voice" ? (transcriptionSessionId ?? null) : null,
      origin: inputKind,
    },
    timings: trace.timings(),
    traceId: trace.id,
  }));
}
