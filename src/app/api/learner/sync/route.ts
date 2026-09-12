import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { checkLimit, limitKey } from "@/lib/limits";
import { subjectMissing } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { MAX_SYNC_BYTES, MAX_SYNC_EVENTS, MAX_SYNC_SUBJECTS, SyncRequestSchema, applySync, learnerSnapshot } from "@/lib/sync";
import { err } from "@/lib/types";

/**
 * POST /api/learner/sync — the browser hands its record back; VIVA merges it.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * Request  `application/json`, at most 512 KB:
 *
 *   {
 *     "events": [                          // 0…200, any order (sorted here)
 *       {
 *         "clientEventId": "b1e9…",        // REQUIRED — the dedupe key. Same
 *                                          //   value the turn was posted with.
 *         "createdAt": "2026-09-12T18:42:11.004Z",  // or "at". Future clamps
 *                                          //   to now; >400 days old rejected.
 *         "intent": "claim",               // REQUIRED — LearningIntent
 *         "transcript": "…",               // REQUIRED — ≤6000 chars
 *         "cleanedTranscript": "…",        // optional, defaults to transcript
 *         "courseId": "course_transformers_w4" | null,
 *         "conceptIds": ["c_position"],    // ≤6
 *         "primaryConceptId": "c_position" | null,
 *         "origin": "voice" | "typed" | "external-dictation",
 *         "transcriptionConfidence": 0…1 | null,   // the Dictation footer,
 *         "transcriptionLatencyMs": 554 | null,    //   replayed so it still
 *         "transcriptionMode": "dictation" | "sync" | null,      // shows
 *         "transcriptionFellBackFrom": "dictation" | "sync" | null,
 *         "transcriptVerbatim": "what the mic heard" | null,     // after a reload
 *         "assessment": "correct" | "partial" | "incorrect" | null,
 *         "masterySignal": "up" | "down" | "flat" | null,
 *         "teachbackScore": 0…1 | null,
 *         "importance": 0…1, "confusion": 0…1, "interpretationConfidence": 0…1,
 *         "evidenceIds": ["ch_…"],         // ≤8
 *         "requestedAction": "quiz" | "store" | … | "none",
 *         "sourceLocator": { "page": 11, "section": "…" } | null,
 *         "hint": "…" | null,
 *         "sessionId": "…"
 *       }
 *     ],
 *     "subjects": [ <the full `record` object from POST /api/subjects/create> ]  // 0…10
 *   }
 *
 * Every field except `clientEventId`, `intent` and `transcript` is optional,
 * and unknown fields are ignored — so the client stores `{...json.event,
 * clientEventId}` from any mutating route and posts that object straight back.
 *
 * Response 200:
 *
 *   {
 *     "sync": {
 *       "events":   { "applied": 3, "duplicate": 4, "rejected": 0 },
 *       "subjects": { "applied": 1, "duplicate": 0, "rejected": 0 },
 *       "rejected": [ { "id": "…", "why": "…" } ]        // ≤10, for debugging
 *     },
 *     …and then exactly the payload of GET /api/learner:
 *     "mastery", "events", "concepts", "priors", "courses", "productEvents",
 *     "activeCourseId", "learner", "backend",
 *     "durable": false,
 *     "storageNote": "Your record lives in this browser. …"   // null when durable
 *   }
 *
 * Errors: 400 `{error:{code,message,retryable}}` for unreadable JSON or a body
 * that fails the schema, 413 over 512 KB, 429 with `Retry-After`. A single bad
 * event is never an error — it is counted in `rejected` and the rest still
 * lands. `?subject=<id>` scopes the returned view, same as GET /api/learner.
 *
 * ── WHY REPLAY IS SAFE TO RUN TWICE ─────────────────────────────────────────
 * `clientEventId` is the store's idempotency key, so the second replay of an
 * event is recognised and dropped before the mastery fold sees it. Mastery is
 * never accepted from the client: it is recomputed from the replayed events by
 * the one fold in `src/lib/mastery.ts`. Reload twice and your map does not
 * move. Post a mastery map and it is ignored — but post hand-written graded
 * events and the fold will believe them, because a replayed event is exactly
 * what a real one looks like. See the note in `src/lib/sync.ts` for why that
 * trade is taken: it is the learner's own account, and lying to it only buys
 * them a plan that skips what they do not know.
 */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["sync", clientIp(req)]), "compile");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "That was a lot of catching up at once — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  // Answer the size before buffering it, so an oversize mirror gets a sentence
  // instead of whatever the platform would have said on this app's behalf.
  // Then check again after reading: a chunked request declares no length, and
  // "we only enforce the limit when the caller tells us the size" is not a
  // limit. The second check is what actually holds.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SYNC_BYTES) return done(tooLarge());

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_SYNC_BYTES) return done(tooLarge());
    body = JSON.parse(raw);
  } catch { return done(err("BAD_REQUEST", "Expected JSON.", false, 400)); }

  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "the request";
    return done(err(
      "BAD_REQUEST",
      `VIVA could not read that saved record (${where}). At most ${MAX_SYNC_EVENTS} notes and ${MAX_SYNC_SUBJECTS} subjects in one go.`,
      false,
      400
    ));
  }

  const store = getStore();
  const sync = await applySync(store, identity.userId, parsed.data);
  // `new URL(req.url)` rather than `req.nextUrl`, so the handler is a plain
  // Request handler and a test can call it without standing up the framework.
  const params = new URL(req.url).searchParams;
  const subject = params.get("subject") ?? params.get("courseId");
  try {
    return done(Response.json({ sync, ...await learnerSnapshot(store, identity.userId, subject) }));
  } catch (error) {
    // The merge already happened and is kept — only the view asked for a
    // subject that does not resolve. Answering 500 would tell the browser its
    // record failed when the record is exactly what just landed.
    return done(subjectMissing(error));
  }
}

function tooLarge(): Response {
  const kb = Math.round(MAX_SYNC_BYTES / 1024);
  return err(
    "SYNC_TOO_LARGE",
    `That saved record is over ${kb} KB, which is more than VIVA takes in one go. Send the most recent part.`,
    false,
    413
  );
}
