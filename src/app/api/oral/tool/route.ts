import { z } from "zod";
import { after } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { rid, serverLog } from "@/lib/observe";
import { getStore } from "@/lib/store";
import { resolveSubject, subjectMissing, keytermsFrom } from "@/lib/courses/subject";
import { getCourse } from "@/lib/courses";
import { runOralTool, toolDefsForWire, MAX_ANSWER, type OralVerdict } from "@/lib/oral/tools";
import { turnResultOf, type Turn } from "@/lib/oral/next-concept";
import { nextFocusFor } from "@/lib/oral/steering";
import { resolveConceptId } from "@/lib/oral/debrief";
import { err } from "@/lib/types";

/**
 * POST /api/oral/tool, run one grounded tool on the caller's behalf.
 *
 * The agent calls tools from the browser, and the browser cannot be the thing
 * that holds a database handle. So a `tool.call` becomes a POST here, the
 * material is resolved server-side from the session cookie, and only the
 * result goes back to the socket. The agent never sees a passage the caller
 * does not own, because it is never handed one: the browser cannot name a
 * subject id that changes which material this route reads.
 *
 * `sessionId` is a client-generated label used for idempotency. It is not an
 * AssemblyAI session id and grants no authority, the learner bucket below is
 * what actually bounds spend.
 */

const Body = z.object({
  callId: z.string().min(1).max(120),
  name: z.string().min(1).max(60),
  arguments: z.record(z.unknown()).optional(),
  subjectId: z.string().max(80).optional(),
  sessionId: z.string().max(120).nullish(),
  /** The learner transcript item the call was built from. Logged, never trusted. */
  transcriptId: z.string().max(120).nullish(),
});

/** Only what the Voice Agent is offered. save_note and the lexical tools are not on this list. */
const WIRE_TOOLS: ReadonlySet<string> = new Set(toolDefsForWire().map((d) => d.name));

/** A tool call is a few hundred bytes. Anything near this is not one. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Read at most MAX_BODY_BYTES; null means the body was larger. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function problem(issues: { code: string; path: PropertyKey[] }[]): string {
  if (issues.some((i) => i.code === "too_big")) return "That was longer than VIVA takes in one go.";
  const field = issues[0]?.path.join(".") || "the request";
  return `That tool call was not shaped the way VIVA expects (${field}).`;
}

export async function POST(req: Request): Promise<Response> {
  const traceId = rid();
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  for (const bucket of [["oral-tool", clientIp(req)], ["oral-tool-did", identity.userId]]) {
    const rl = checkLimit(limitKey(bucket), "compile");
    if (!rl.ok) {
      serverLog("oral_tool.rate_limited", traceId, {});
      return done(
        Response.json(
          { error: { code: "RATE_LIMITED", message: "Slow down a little, try again in a moment.", retryable: true } },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSec), "Cache-Control": "no-store" } }
        )
      );
    }
  }

  let body: unknown;
  try {
    const text = await readCapped(req);
    if (text === null) return done(err("PAYLOAD_TOO_LARGE", "That was longer than VIVA takes in one go.", false, 413));
    body = JSON.parse(text);
  } catch {
    return done(err("BAD_REQUEST", "Expected JSON.", false, 400));
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return done(err("BAD_REQUEST", problem(parsed.error.issues), false, 400));

  const { callId, name, arguments: args, subjectId } = parsed.data;
  const sessionId = parsed.data.sessionId ?? undefined;

  if (!WIRE_TOOLS.has(name)) {
    // Not offered to the agent, so not run for it either. save_note carried a
    // model-supplied `correct` flag that filed a mastery signal the material
    // never produced, and a prompt-injected agent could call it by name.
    serverLog("oral_tool.refused", traceId, { tool: name.slice(0, 40) });
    return done(
      Response.json(
        { callId, result: { error: "That tool is not available.", tell_the_student: "That tool is not available." }, isError: true },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  }

  try {
    const store = getStore();
    const subject = await resolveSubject(store, identity.userId, subjectId ?? null);
    // The starter courses live in the registry, not in the caller's store, so
    // this is the only path that can hand a demo session its material.
    const course = subject.origin === "starter" || subject.demo ? getCourse(subject.id) : null;
    const chunks = await store.getCourseChunks(identity.userId, subject.id);
    // The answer this call checked, if it checked one: the next question is chosen from it.
    let current: Turn | null = null;

    const { result, isError } = await runOralTool(
      {
        subject,
        course,
        chunks,
        onVerdict: async (v: OralVerdict) => {
          // The learner's map is written from the verdict a tool returned, with the
          // same event shape the written study loop uses, so mastery.ts folds it.
          const claim = (v.kind === "claim" ? v.claim : v.answer).slice(0, MAX_ANSWER);
          const conceptId = resolveConceptId(subject.concepts, claim);
          const assessment = v.kind === "claim" ? (v.verdict === "supported" ? "correct" : "incorrect") : v.grade;
          current = { conceptId, result: turnResultOf(v) };
          // After the response: the store write measured about a second, and the
          // agent is waiting on this result to speak. A failed write is logged.
          after(async () => { try { await store.recordLearning(identity.userId, {
            idempotencyKey: `oral_${sessionId ?? traceId}_${callId}`.slice(0, 120),
            sessionId: sessionId ?? `oral_${traceId}`,
            courseId: subject.id,
            sourceId: subject.sources?.[0]?.id ?? null,
            transcript: claim,
            cleanedTranscript: claim,
            origin: "voice",
            transcriptionConfidence: null,
            transcriptionLatencyMs: null,
            transcriptionSessionId: null,
            intent: "claim",
            conceptIds: conceptId ? [conceptId] : [],
            primaryConceptId: conceptId,
            importance: 0.5,
            confusion: assessment === "incorrect" ? 0.8 : assessment === "partial" ? 0.4 : 0.1,
            interpretationConfidence: 0.8,
            evidenceIds: v.kind === "claim" ? [v.passageId] : [],
            requestedAction: "evaluate",
            status: "responded",
            sourceLocator: v.kind === "claim" && v.page != null ? { page: v.page } : null,
            assessment,
            masterySignal: assessment === "correct" ? "up" : assessment === "incorrect" ? "down" : "flat",
            hint: null,
          }); } catch (e) { serverLog("oral_tool.verdict_write_failed", traceId, { err: (e as Error).message?.slice(0, 160) }); } });
        },
      },
      name,
      args
    );

    if (!isError && !current && name === "verify_claim" && result.verdict === "not_in_material") {
      const claim = typeof args?.claim === "string" ? args.claim : "";
      const concept = typeof args?.concept === "string" ? args.concept : null;
      current = { conceptId: resolveConceptId(subject.concepts, concept, claim), result: "unsettled" };
    }
    if (!isError && current) {
      // A failed read leaves the result as the tool returned it: no focus, and the prompt says what to do then.
      try {
        const [mastery, events] = await Promise.all([store.getMastery(identity.userId), store.listEvents(identity.userId, 200)]);
        const focus = nextFocusFor({
          concepts: subject.concepts.map((c) => ({ id: c.id, name: c.name })),
          mastery,
          events,
          sessionId: sessionId ?? `oral_${traceId}`,
          current,
          now: new Date().toISOString(),
        });
        if (focus) result.next_focus = focus;
      } catch (e) {
        serverLog("oral_tool.focus_failed", traceId, { err: (e as Error).message?.slice(0, 160) });
      }
    }

    serverLog("oral_tool.called", traceId, { tool: name, isError, chunks: chunks.length });
    return done(
      Response.json(
        { callId, result, isError },
        { headers: { "Cache-Control": "no-store" } }
      )
    );
  } catch (e) {
    if (e instanceof Error && e.name === "SubjectNotFoundError") {
      return done(subjectMissing(e));
    }
    serverLog("oral_tool.failed", traceId, { tool: name, err: (e as Error).message?.slice(0, 200) });
    return done(err("TOOL_FAILED", "That check could not be run.", true, 502));
  }
}

/** Key terms boost transcription. Exposed so the client can pass them to
 *  `session.update` rather than inventing its own list. */
export async function GET(req: Request): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  const subjectId = new URL(req.url).searchParams.get("subjectId");
  try {
    const store = getStore();
    const subject = await resolveSubject(store, identity.userId, subjectId);
    return withIdentityCookie(
      Response.json({ subjectId: subject.id, title: subject.title, keyterms: keytermsFrom(subject.concepts) }),
      setCookie
    );
  } catch (e) {
    if (e instanceof Error && e.name === "SubjectNotFoundError") return withIdentityCookie(subjectMissing(e), setCookie);
    throw e;
  }
}
