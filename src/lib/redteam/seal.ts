import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { REVIEW_MODES, type RedteamSession } from "./types";

/**
 * A review that travels with the browser.
 *
 * Without DATABASE_URL a review lives in one server instance's memory and temp
 * directory. On a serverless host the next request can land on an instance that
 * has never heard of it, and that instance answers "not here" in the middle of
 * a review. So every response carries a sealed copy of the review, and the
 * browser hands it back through /api/redteam/session/restore when that happens.
 *
 * The one rule this file exists to keep: the browser can carry the ledger but
 * cannot write it. The copy is authenticated, not encrypted. The person can
 * read their own document and verdicts (they are on their screen already) but
 * changing a single byte of the copy makes it fail, so a restore can only ever
 * bring back a ledger this server produced from the document.
 *
 * The owner is bound to the copy but is not in it. `userId` is the HttpOnly
 * cookie value behind a prefix, and putting it in something page JavaScript can
 * read would undo what HttpOnly is for. It goes into the signature's input
 * only, so a copy taken to another browser does not open there.
 *
 * Sizes, measured 2026-09-29: the sample review is 4.8 KB of JSON and 1.9 KB
 * sealed. Each claim round adds about 1.8 KB of JSON, which deflates about
 * 12 to 1. A full 60,000-character document with about 220 claim rounds is
 * 512 KB of JSON and 75 KB sealed. Sealing takes at most about 7 ms.
 */

export type Snapshot = { data: string; sig: string };

/** A copy must not outlive the session it copies: the store expires a review six hours after its last event. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The most a copy may inflate to. Twice the 512 KB a full-size document and
 * about 220 claim rounds reach, so no real review is refused, and far below
 * what a small deflate stream can be made to expand to. It is checked while
 * inflating (`maxOutputLength`), so the bomb is never built and only stopped.
 */
const MAX_INFLATED_BYTES = 1024 * 1024;

/** The longest `data` a restore accepts: more than four times what a review at that 512 KB mark seals to. */
export const MAX_SNAPSHOT_CHARS = 350_000;

const LABEL = "viva-redteam-snapshot-v1";

/** The floor MCP token signing uses too: shorter than this can be guessed offline from one copy. */
const MIN_SECRET_CHARS = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let ephemeral: Buffer | null = null;

/**
 * The signing key, and it has to be the same on every instance or a copy sealed
 * by one is refused by the next.
 *
 * Derived from whichever deployment secret is configured first. REDTEAM_SECRET
 * is the one to set on purpose. The other two are values every deployment that
 * can run a review already has, so the fix works without a new setting, and
 * they are hashed with a label so the key is never the secret itself. The
 * secrets are long random strings, so one SHA-256 is enough; there is nothing to
 * stretch.
 *
 * With none configured the key is random for this process. A copy then only
 * restores on the instance that sealed it, which is exactly the situation the
 * copy was meant to fix, so on a serverless host with no secret this feature
 * quietly does nothing rather than accepting a copy it cannot vouch for.
 */
function key(): Buffer {
  for (const name of ["REDTEAM_SECRET", "ASSEMBLYAI_API_KEY", "DATABASE_URL"]) {
    const value = process.env[name];
    if (value && value.length >= MIN_SECRET_CHARS) return createHash("sha256").update(LABEL).update("\0").update(value).digest();
  }
  return (ephemeral ??= randomBytes(32));
}

/** The signature over one copy for one owner. `v1.` is the format, so a later change cannot be replayed as this one. */
function tag(userId: string, data: string): string {
  return createHmac("sha256", key()).update("v1.").update(userId).update(".").update(data).digest("base64url");
}

/** Equal length first: `timingSafeEqual` throws on a length mismatch, and a throw here would be a signal too. */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Seal a review for its owner. The owner's id is signed over but never written into `data`. */
export function sealSession(s: RedteamSession): Snapshot {
  const { userId, ...rest } = s;
  const data = deflateRawSync(JSON.stringify(rest)).toString("base64url");
  return { data, sig: tag(userId, data) };
}

/**
 * Just enough shape that a restored review cannot crash the code that reads it.
 * The signature already says this server wrote it; this only guards against a
 * copy from a build whose sessions looked different. It stays small on purpose:
 * a check that is stricter than the real shape refuses honest copies, and
 * nothing would say why.
 */
function looksLikeSession(x: unknown): x is Omit<RedteamSession, "userId"> {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, any>;
  return (
    typeof s.id === "string" &&
    UUID.test(s.id) &&
    (REVIEW_MODES as readonly string[]).includes(s.mode) &&
    (s.status === "active" || s.status === "ended") &&
    Boolean(s.document) &&
    typeof s.document === "object" &&
    Array.isArray(s.document.passages) &&
    Array.isArray(s.document.sections) &&
    Array.isArray(s.claims) &&
    Array.isArray(s.timeline) &&
    Array.isArray(s.challenges) &&
    Number.isFinite(s.turnCounter) &&
    typeof s.createdAt === "string" &&
    typeof s.updatedAt === "string"
  );
}

/**
 * Open a copy for the person asking, or say nothing at all.
 *
 * Every failure is the same `null`: a wrong owner, a changed byte, a bad
 * encoding, an old copy. The route turns it into the answer it gives for a
 * review that does not exist, so a caller cannot use it to learn which of those
 * it was, or whether a review exists. Nothing here logs the copy or the reason.
 *
 * The order is the point. The signature is checked before anything is decoded,
 * so nothing a caller made ever reaches the inflater or the JSON parser. The
 * inflater is capped anyway, because the day a key leaks is not the day to find
 * out it was uncapped.
 */
export function openSeal(userId: string, snapshot: Snapshot): RedteamSession | null {
  try {
    if (typeof snapshot?.data !== "string" || typeof snapshot.sig !== "string") return null;
    if (!sameText(snapshot.sig, tag(userId, snapshot.data))) return null;
    const json = inflateRawSync(Buffer.from(snapshot.data, "base64url"), { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!looksLikeSession(parsed)) return null;
    // Either side of now: instances' clocks differ a little, so a copy stamped
    // a moment ahead is fine, and one stamped hours ahead is not.
    if (!(Math.abs(Date.now() - Date.parse(parsed.updatedAt)) < MAX_AGE_MS)) return null;
    return { ...parsed, userId };
  } catch {
    return null;
  }
}

/**
 * How many events of a review a copy has seen. The timeline only ever grows, so
 * along one review this number only goes up, and it does not depend on any
 * instance's clock. Clients report it (see http.ts) and copies are compared by it.
 *
 * It does not move for the few changes that add no event: a reply finishing, or
 * talk that was not a claim. An instance that missed only those is not noticed.
 * They set which reply a barge-in refers to, not a verdict, and every verdict is
 * still worked out from the document, so the ledger cannot be affected.
 */
export function revisionOf(s: { timeline: readonly unknown[] }): number {
  return s.timeline.length;
}

/**
 * Has `a` seen more of the review than `b`?
 *
 * More events wins, and `updatedAt` only breaks a tie. `updatedAt` alone is
 * the wrong judge: it is stamped by whichever instance handled the request, so
 * two instances a second apart can disagree about which came last, some
 * changes (a reply finishing) do not move it at all, and a stale copy that
 * answered a call after a fork carries a later time than the history it lost.
 */
export function isNewerCopy(a: Pick<RedteamSession, "timeline" | "updatedAt">, b: Pick<RedteamSession, "timeline" | "updatedAt">): boolean {
  const ra = revisionOf(a);
  const rb = revisionOf(b);
  if (ra !== rb) return ra > rb;
  return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
}
