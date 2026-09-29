import { z } from "zod";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { rid, serverLog } from "@/lib/observe";
import { getStore, storeDurability } from "@/lib/store";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { buildDebrief, debriefToText } from "@/lib/oral/debrief";
import { err } from "@/lib/types";

/**
 * POST /api/oral/debrief: the summary and tomorrow's plan for one oral exam.
 *
 * The browser sends the session record it kept (each verdict a tool returned,
 * the learner's words, counts). The server does not trust the citations in it:
 * every quote is re-checked against the passages before it can reach the sheet.
 * The learner's map was already written by /api/oral/tool as each verdict came
 * back, so the plan here is the Today planner run on what the store now holds.
 * The debrief itself is derived, not stored: it can be rebuilt from the record.
 */

const Entry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim"),
    conceptId: z.string().max(80).nullable().default(null),
    learner: z.string().min(1).max(2000),
    verdict: z.enum(["supported", "contradicted", "not_in_material"]),
    quote: z.string().max(1400).nullable().default(null),
    page: z.number().int().min(0).max(100000).nullable().default(null),
    passageId: z.string().max(120).nullable().default(null),
  }),
  z.object({
    kind: z.literal("answer"),
    conceptId: z.string().max(80).nullable().default(null),
    learner: z.string().min(1).max(2000),
    grade: z.enum(["correct", "partial", "incorrect"]),
  }),
]);

const Body = z.object({
  subjectId: z.string().max(80).optional(),
  record: z.object({
    sessionId: z.string().min(1).max(120),
    startedAt: z.string().max(40),
    userTurns: z.number().int().min(0).max(1000),
    interruptions: z.number().int().min(0).max(1000),
    entries: z.array(Entry).max(80),
  }),
});

export const EPHEMERAL_NOTE = "Demo storage resets when the server restarts.";

export async function POST(req: Request): Promise<Response> {
  const traceId = rid();
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  for (const bucket of [["oral-debrief", clientIp(req)], ["oral-debrief-did", identity.userId]]) {
    const rl = checkLimit(limitKey(bucket), "compile");
    if (!rl.ok) {
      return done(
        Response.json(
          { error: { code: "RATE_LIMITED", message: "Slow down a little and try again in a moment.", retryable: true } },
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
  if (!parsed.success) return done(err("BAD_REQUEST", "That session record was not shaped the way VIVA expects.", false, 400));

  try {
    const store = getStore();
    const subject = await resolveSubject(store, identity.userId, parsed.data.subjectId ?? null);
    const [chunks, mastery, events, durability] = await Promise.all([
      store.getCourseChunks(identity.userId, subject.id),
      store.getMastery(identity.userId),
      store.listEvents(identity.userId, 200),
      storeDurability(),
    ]);
    const debrief = buildDebrief({ record: parsed.data.record, concepts: subject.concepts, chunks, mastery, events, now: new Date() });
    debrief.storage = {
      durable: durability.durable,
      note: durability.durable ? "Saved for your next session." : EPHEMERAL_NOTE,
    };
    serverLog("oral_debrief.built", traceId, { entries: parsed.data.record.entries.length, dropped: debrief.citationsDropped });
    return done(Response.json({ debrief, text: debriefToText(debrief) }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    if (e instanceof Error && e.name === "SubjectNotFoundError") return done(subjectMissing(e));
    serverLog("oral_debrief.failed", traceId, { err: (e as Error).message?.slice(0, 200) });
    return done(err("DEBRIEF_FAILED", "The debrief could not be built.", true, 502));
  }
}
