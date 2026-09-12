import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { DEMO_USER_PREFIX, demoCookieName } from "@/lib/auth/identity";

/**
 * Identity for the MCP endpoint.
 *
 * VIVA's identity is the `viva_did` HttpOnly cookie. An MCP client has no
 * cookie jar, so the student pairs one explicitly:
 *
 *   1. Signed in to nothing, they open /connect in the browser that already
 *      holds their cookie. That page mints a PAIRING CODE from the cookie.
 *   2. They paste the code into their assistant, which calls
 *      `connect_my_viva_account`. The code is exchanged for an ACCESS TOKEN.
 *   3. Every later call carries the access token, and the token is the ONLY
 *      thing that decides whose rows are read.
 *
 * Both are the same construction: a 22-byte payload carrying the version, the
 * purpose, an expiry and the 128-bit device id, plus a 128-bit HMAC tag over
 * it. Nothing else is trusted — this module never reads a cookie, never reads
 * a user id from a tool argument, and never takes a hint from the request
 * body. The old `resolveSubject` bug in this repo (an id from the caller
 * silently resolving to somebody else's material) is exactly the shape of
 * mistake the token-only rule exists to make impossible.
 *
 * The tag is truncated to 128 bits: the payload is opaque and short-lived, and
 * a forgery needs a preimage of a keyed hash, not a collision.
 */

const VERSION = 1;
const PURPOSE_BYTE = { pair: 1, access: 2 } as const;
export type TokenPurpose = keyof typeof PURPOSE_BYTE;

/** A pairing code is meant to be pasted within a minute or two, not stored. */
export const PAIR_TTL_SECONDS = 10 * 60;
/** An access token lives as long as a term's worth of study sessions. */
export const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;

const PREFIX: Record<TokenPurpose, string> = { pair: "viva-pair-", access: "viva-key-" };
const PAYLOAD_BYTES = 22;
const TAG_BYTES = 16;
const DID = /^[0-9a-f]{32}$/;

let ephemeralSecret: Buffer | null = null;

/**
 * The signing key.
 *
 * ponytail: with no MCP_TOKEN_SECRET set the key is random per process, so
 * tokens stop working when the instance recycles or the app redeploys — the
 * same per-instance honesty the file store already ships with. Set
 * MCP_TOKEN_SECRET (32+ random characters) to make pairings outlive a deploy.
 * A shared secret is all this needs; there is no token table to add.
 */
function secret(): Buffer {
  const configured = process.env.MCP_TOKEN_SECRET;
  if (configured && configured.length >= 16) return Buffer.from(configured, "utf8");
  if (!ephemeralSecret) ephemeralSecret = randomBytes(32);
  return ephemeralSecret;
}

/** Whether a paired token survives a redeploy, so the page can say which it is. */
export function pairingSurvivesDeploys(): boolean {
  const configured = process.env.MCP_TOKEN_SECRET;
  return Boolean(configured && configured.length >= 16);
}

function tag(payload: Buffer): Buffer {
  return createHmac("sha256", secret()).update(payload).digest().subarray(0, TAG_BYTES);
}

/** Mint a pairing code or an access token for one device id. */
export function mintToken(did: string, purpose: TokenPurpose, now = Date.now()): string {
  if (!DID.test(did)) throw new Error("mintToken: device id must be 32 hex characters");
  const ttl = purpose === "pair" ? PAIR_TTL_SECONDS : ACCESS_TTL_SECONDS;
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(VERSION, 0);
  payload.writeUInt8(PURPOSE_BYTE[purpose], 1);
  payload.writeUInt32BE(Math.floor(now / 1000) + ttl, 2);
  Buffer.from(did, "hex").copy(payload, 6);
  return PREFIX[purpose] + Buffer.concat([payload, tag(payload)]).toString("base64url");
}

export type TokenCheck =
  | { ok: true; did: string; expiresAt: Date }
  | { ok: false; reason: "missing" | "malformed" | "forged" | "expired" | "wrong_purpose" };

/** Read a token back. Every failure is a refusal; none of them fall through. */
export function readToken(raw: unknown, purpose: TokenPurpose, now = Date.now()): TokenCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };
  const trimmed = raw.trim();
  const expected = PREFIX[purpose];
  const other = PREFIX[purpose === "pair" ? "access" : "pair"];
  if (trimmed.startsWith(other)) return { ok: false, reason: "wrong_purpose" };
  if (!trimmed.startsWith(expected)) return { ok: false, reason: "malformed" };

  const bytes = Buffer.from(trimmed.slice(expected.length), "base64url");
  if (bytes.length !== PAYLOAD_BYTES + TAG_BYTES) return { ok: false, reason: "malformed" };
  const payload = bytes.subarray(0, PAYLOAD_BYTES);
  const presented = bytes.subarray(PAYLOAD_BYTES);
  // Signature first: nothing inside the payload may be believed before the tag
  // over it verifies, or a caller edits the device id and reads another
  // student's subjects.
  if (!timingSafeEqual(presented, tag(payload))) return { ok: false, reason: "forged" };
  if (payload.readUInt8(0) !== VERSION) return { ok: false, reason: "malformed" };
  if (payload.readUInt8(1) !== PURPOSE_BYTE[purpose]) return { ok: false, reason: "wrong_purpose" };
  const expiresAt = new Date(payload.readUInt32BE(2) * 1000);
  if (expiresAt.getTime() <= now) return { ok: false, reason: "expired" };
  return { ok: true, did: payload.subarray(6).toString("hex"), expiresAt };
}

/**
 * The device id behind a tool call: the `Authorization: Bearer` header if the
 * student put the token in their client config, otherwise the `account_token`
 * argument the pairing tool handed back. Deliberately the whole list — no
 * cookie, no user id, no subject-owner hint.
 */
export function identityForCall(authorization: string | null, argToken: unknown, now = Date.now()): TokenCheck {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  const header = readToken(bearer, "access", now);
  if (header.ok || (bearer && header.reason !== "missing")) return header;
  return readToken(argToken, "access", now);
}

/** The cookie the app's own routes read, rebuilt from a verified device id. */
export function cookieFor(did: string): string {
  return `${demoCookieName()}=${did}`;
}

/** The row owner the app's routes will derive from that cookie. */
export function userIdFor(did: string): string {
  return `${DEMO_USER_PREFIX}${did}`;
}

/** The 32-hex device id inside a `viva_did` cookie value, if it is one. */
export function didFromCookieValue(value: string | undefined): string | null {
  return value && DID.test(value) ? value : null;
}
