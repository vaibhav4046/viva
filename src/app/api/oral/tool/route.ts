import { z } from "zod";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { rid, serverLog } from "@/lib/observe";
import { getStore } from "@/lib/store";
import { resolveSubject, subjectMissing, keytermsFrom } from "@/lib/courses/subject";
import { getCourse } from "@/lib/courses";
import { runOralTool, MAX_ANSWER } from "@/lib/oral/tools";
import { err } from "@/lib/types";

/**
 * POST /api/oral/tool — run one grounded tool on the caller's behalf.
 *
 * The agent calls tools from the browser, and the browser cannot be the thing
 * that holds a database handle. So a `tool.call` becomes a POST here, the
 * material is resolved server-side from the session cookie, and only the
 * result goes back to the socket. The agent never sees a passage the caller
 * does not own, because it is never handed one: the browser cannot name a
 * subject id that changes which material this route reads.
 *
 * `sessionId` is a client-generated label used for idempotency. It is not an
 * AssemblyAI session id and grants no authority — the learner bucket below is
 * what actually bounds spend.
 */

const Body = z.object({
  callId: z.string().min(1).max(120),
  name: z.string().min(1).max(60),
  arguments: z.record(z.unknown()).optional(),
  subjectId: z.string().max(80).optional(),
  sessionId: z.string().max(120).optional(),
});

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
          { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSec), "Cache-Control": "no-store" } }
        )
      );
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return done(err("BAD_REQUEST", "Expected JSON.", false, 400));
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return done(err("BAD_REQUEST", problem(parsed.error.issues), false, 400));

  const { callId, name, arguments: args, subjectId, sessionId } = parsed.data;

  try {
    const store = getStore();
    const subject = await resolveSubject(store, identity.userId, subjectId ?? null);
    // The starter courses live in the registry, not in the caller's store, so
    // this is the only path that can hand a demo session its material.
    const course = subject.origin === "starter" || subject.demo ? getCourse(subject.id) : null;
    const chunks = await store.getCourseChunks(identity.userId, subject.id);

    const { result, isError } = await runOralTool(
      {
        subject,
        course,
        chunks,
        onNote: async ({ claim, conceptId, correct }) => {
          // Only a claim the material actually supports is filed as right, and
          // the store gets a clean model-free signal. The spoken feedback is
          // the agent's business; the record's is not.
          //
          // `intent: "claim"` is the load-bearing field. It is the same value
          // the written study loop uses for a graded answer, which is the only
          // path `mastery.ts` has a case for. Filing the oral exchange as
          // `"confusion"` instead would drop it as a process turn and the
          // learner's spoken exam would leave no trace on their map — the one
          // place the oral exam must not be a second-class citizen.
          const capped = claim.slice(0, MAX_ANSWER);
          await store.recordLearning(identity.userId, {
            idempotencyKey: `oral_${sessionId ?? traceId}_${callId}`.slice(0, 120),
            sessionId: sessionId ?? `oral_${traceId}`,
            courseId: subject.id,
            sourceId: subject.sources?.[0]?.id ?? null,
            transcript: capped,
            cleanedTranscript: capped,
            origin: "voice",
            transcriptionConfidence: null,
            transcriptionLatencyMs: null,
            transcriptionSessionId: null,
            intent: "claim",
            conceptIds: conceptId ? [conceptId] : [],
            primaryConceptId: conceptId ?? null,
            importance: 0.5,
            confusion: correct ? 0.1 : 0.8,
            interpretationConfidence: 0.8,
            evidenceIds: [],
            requestedAction: "evaluate",
            status: "responded",
            sourceLocator: null,
            assessment: correct ? "correct" : "incorrect",
            masterySignal: correct ? "up" : "down",
            hint: null,
          });
        },
      },
      name,
      args
    );

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
