import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let did = "5e".repeat(16);
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "viva_did" ? { value: did } : undefined) }),
}));

import { POST as CREATE } from "@/app/api/redteam/session/route";
import { GET as LOAD } from "@/app/api/redteam/session/[id]/route";
import { POST as RESTORE } from "@/app/api/redteam/session/restore/route";
import { POST as TOOL } from "@/app/api/redteam/tool/route";
import { POST as TURN } from "@/app/api/redteam/turn/route";
import { POST as TYPED } from "@/app/api/redteam/typed/route";
import { POST as END } from "@/app/api/redteam/end/route";
import { __resetSnapshots, createReview, httpApi, loadReview } from "@/components/redteam/api";
import { __resetLimits } from "@/lib/limits";
import { reviewFields } from "@/lib/redteam/http";
import { MAX_SNAPSHOT_CHARS, isNewerCopy, openSeal, revisionOf, sealSession, type Snapshot } from "@/lib/redteam/seal";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "@/lib/redteam/sample";
import { createSession, markInterrupted, recordUtterance } from "@/lib/redteam/session";
import { __resetSessions, getSession, saveSession } from "@/lib/redteam/store";
import { runTool } from "@/lib/redteam/tools";
import type { RedteamSession } from "@/lib/redteam/types";

/**
 * A review that survives the server instance that held it.
 *
 * Three layers, each tested where it can fail: the seal (can a copy be forged,
 * moved to another owner, aged, or used to hurt the server), the routes (does a
 * review come back after an instance forgets it, and is a bad copy
 * indistinguishable from a missing review), and the browser client (does it
 * restore once, retry once, and never on any other error).
 */

const SECRET = "test-redteam-secret-0123456789abcdef";
const OWNER = `demo_${"a".repeat(32)}`;
const OTHER = `demo_${"b".repeat(32)}`;
const KEYS = ["REDTEAM_SECRET", "ASSEMBLYAI_API_KEY", "DATABASE_URL", "REDTEAM_DIR"] as const;

const savedEnv: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const savedFetch = globalThis.fetch;
let dir = "";

beforeEach(() => {
  __resetLimits();
  __resetSessions();
  __resetSnapshots();
  did = "5e".repeat(16);
  delete process.env.DATABASE_URL;
  delete process.env.ASSEMBLYAI_API_KEY;
  process.env.REDTEAM_SECRET = SECRET;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "viva-seal-"));
  process.env.REDTEAM_DIR = dir;
});

afterEach(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

/** A review with a ledger, a timeline, a barge-in and the soft fields a reply leaves behind. */
function review(userId = OWNER): RedteamSession {
  const s = createSession({ userId, mode: "SKEPTIC", title: SAMPLE_TITLE, text: SAMPLE_TEXT, sample: true });
  recordUtterance(s, "We automatically fail over to a replica.");
  runTool(s, "evaluate_spoken_claim", { spoken_text: "We guarantee GDPR compliance and SOC 2 certification for all customer data." });
  markInterrupted(s);
  return s;
}

const withoutOwner = (s: RedteamSession) => {
  const { userId: _omitted, ...rest } = s;
  return rest;
};

/**
 * Sign arbitrary bytes the way the server does, for an attacker who HAS the key.
 * It is written out here rather than imported so this file also pins the wire
 * format: label, separator, `v1.` prefix, base64url. Everything a signature
 * cannot protect against (a bomb, garbage, a wrong shape) is tested with it.
 */
function forge(userId: string, payload: Buffer | string, secret = SECRET): Snapshot {
  const data = deflateRawSync(payload).toString("base64url");
  return { data, sig: signed(userId, data, secret) };
}

function signed(userId: string, data: string, secret = SECRET): string {
  const key = createHash("sha256").update("viva-redteam-snapshot-v1").update("\0").update(secret).digest();
  return createHmac("sha256", key).update("v1.").update(userId).update(".").update(data).digest("base64url");
}

/** Flip one character to a different valid base64url character. */
function flip(text: string, at: number): string {
  const i = at < 0 ? text.length + at : at;
  return text.slice(0, i) + (text[i] === "A" ? "B" : "A") + text.slice(i + 1);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The same decoded bytes spelled differently: only the two spare low bits of the last character change. */
function respell(text: string): string {
  const last = ALPHABET.indexOf(text.at(-1)!);
  return text.slice(0, -1) + ALPHABET[(last & ~3) | (((last & 3) + 1) & 3)];
}

/** What a request that lands on a different serverless instance sees: no memory, and a /tmp of its own. */
function newInstance(): void {
  __resetSessions();
  fs.rmSync(dir, { recursive: true, force: true });
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/redteam/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = () => new Request("http://localhost/api/redteam/x");
const GHOST = "00000000-0000-0000-0000-000000000000";

type Created = { session: any; snapshot: Snapshot; voice: any };

async function start(): Promise<Created> {
  const res = await CREATE(json({ mode: "SKEPTIC", sample: true }));
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

const tool = (sessionId: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  TOOL(json({ sessionId, name, arguments: args }, headers));

const claim = (sessionId: string, spoken: string, headers: Record<string, string> = {}) => tool(sessionId, "evaluate_spoken_claim", { spoken_text: spoken }, headers);

const CONTRADICTED = "We automatically fail over to a replica.";
const SUPPORTED = "We manually fail over to a replica.";

/** The 404 a review that never existed gets. Everything that must not be an oracle is compared to it. */
async function ghostBody() {
  const res = await LOAD(get(), ctx(GHOST));
  expect(res.status).toBe(404);
  return res.json();
}

/* ------------------------------------------------------------------- the seal */

describe("sealing a review", () => {
  it("round-trips the ledger, the timeline, the document and the soft fields for its owner", () => {
    const s = review();
    const sealed = sealSession(s);
    const back = openSeal(OWNER, sealed);

    expect(back).not.toBeNull();
    // The whole review, not a view of it: what a restore brings back is what the server held.
    expect(back).toEqual(s);
    expect(back!.claims.map((c) => c.status)).toEqual(s.claims.map((c) => c.status));
    expect(back!.claims.length).toBeGreaterThanOrEqual(2);
    expect(back!.timeline).toEqual(s.timeline);
    expect(back!.document).toEqual(s.document);
    expect(back!.explainingClaimId).toBe(s.explainingClaimId);
    expect(back!.recentUtterances).toEqual(s.recentUtterances);
    expect(back!.userId).toBe(OWNER);
    // Compressed, and not by a hair.
    expect(sealed.data.length).toBeLessThan(JSON.stringify(s).length / 2);
    expect(sealed.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("leaves the review it sealed untouched", () => {
    const s = review();
    const before = JSON.stringify(s);
    sealSession(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(s.userId).toBe(OWNER);
  });

  it("puts nothing that identifies the owner where page JavaScript can read it", () => {
    const s = review();
    const sealed = sealSession(s);
    const inflated = inflateRawSync(Buffer.from(sealed.data, "base64url")).toString("utf8");
    expect(inflated).not.toContain(OWNER);
    expect(inflated).not.toContain("a".repeat(32));
    expect(inflated).not.toMatch(/"userId"/);
    expect(JSON.parse(inflated)).not.toHaveProperty("userId");
    expect(JSON.stringify(sealed)).not.toContain("a".repeat(32));
  });

  it("signs with the documented format, so a second implementation could check it", () => {
    const sealed = sealSession(review());
    expect(sealed.sig).toBe(signed(OWNER, sealed.data));
  });

  it("refuses a copy in which any byte of the review was changed", () => {
    const sealed = sealSession(review());
    for (const at of [0, 1, 7, Math.floor(sealed.data.length / 2), sealed.data.length - 2, -1]) {
      expect(openSeal(OWNER, { data: flip(sealed.data, at), sig: sealed.sig }), `data byte ${at}`).toBeNull();
    }
    expect(openSeal(OWNER, { data: `${sealed.data}A`, sig: sealed.sig })).toBeNull();
    expect(openSeal(OWNER, { data: sealed.data.slice(0, -1), sig: sealed.sig })).toBeNull();
  });

  it("refuses a copy whose signature was changed, cut short, extended or swapped", () => {
    const s = review();
    const sealed = sealSession(s);
    for (const at of [0, 20, -2]) expect(openSeal(OWNER, { data: sealed.data, sig: flip(sealed.sig, at) }), `sig byte ${at}`).toBeNull();
    // The last character carries two spare bits, so a lenient decoder reads two
    // spellings as one signature. Only the exact spelling the server wrote opens.
    const twin = respell(sealed.sig);
    expect(twin).not.toBe(sealed.sig);
    expect(Buffer.from(twin, "base64url").equals(Buffer.from(sealed.sig, "base64url"))).toBe(true);
    expect(openSeal(OWNER, { data: sealed.data, sig: twin })).toBeNull();
    expect(openSeal(OWNER, { data: sealed.data, sig: sealed.sig.slice(0, -1) })).toBeNull();
    expect(openSeal(OWNER, { data: sealed.data, sig: `${sealed.sig}A` })).toBeNull();
    expect(openSeal(OWNER, { data: sealed.data, sig: "" })).toBeNull();
    // A genuine signature over different content of the same owner does not carry over.
    s.turnCounter += 1;
    const later = sealSession(s);
    expect(openSeal(OWNER, { data: sealed.data, sig: later.sig })).toBeNull();
    expect(openSeal(OWNER, { data: later.data, sig: sealed.sig })).toBeNull();
  });

  it("does not open for anyone but the owner", () => {
    const sealed = sealSession(review());
    expect(openSeal(OTHER, sealed)).toBeNull();
    expect(openSeal(`${OWNER}0`, sealed)).toBeNull();
    expect(openSeal("", sealed)).toBeNull();
    expect(openSeal(OWNER, sealed)).not.toBeNull();
    // And the other way round: the copy is made for the owner it was sealed for.
    expect(openSeal(OWNER, sealSession(review(OTHER)))).toBeNull();
    expect(openSeal(OTHER, sealSession(review(OTHER)))?.userId).toBe(OTHER);
  });

  it("does not open under a different secret", () => {
    const sealed = sealSession(review());
    process.env.REDTEAM_SECRET = `${SECRET}-rotated`;
    expect(openSeal(OWNER, sealed)).toBeNull();
    process.env.REDTEAM_SECRET = SECRET;
    expect(openSeal(OWNER, sealed)).not.toBeNull();
  });

  it("refuses a copy older than a review lives, and accepts one just inside", () => {
    const hours = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const at = (stamp: string) => {
      const s = review();
      s.updatedAt = stamp;
      return openSeal(OWNER, sealSession(s));
    };
    expect(at(hours(6))).toBeNull();
    expect(at(hours(7))).toBeNull();
    expect(at(hours(5.9))).not.toBeNull();
    // A moment ahead is another instance's clock; hours ahead is not a real copy.
    expect(at(new Date(Date.now() + 60_000).toISOString())).not.toBeNull();
    expect(at(hours(-7))).toBeNull();
    expect(at("not a date")).toBeNull();
  });

  it("measures age when the copy is opened, not when it was sealed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T09:00:00Z"));
    const s = review();
    const sealed = sealSession(s);
    vi.setSystemTime(new Date("2026-09-29T14:30:00Z"));
    expect(openSeal(OWNER, sealed)).not.toBeNull();
    vi.setSystemTime(new Date("2026-09-29T15:30:00Z"));
    expect(openSeal(OWNER, sealed)).toBeNull();
  });

  it("refuses garbage, and never throws", () => {
    const junk: unknown[] = [
      { data: "!!! not base64 !!!", sig: "x" },
      { data: "", sig: "" },
      { data: "AAAA", sig: signed(OWNER, "AAAA") },
      { data: 5, sig: {} },
      { data: "abc" },
      { sig: "abc" },
      {},
      null,
      undefined,
      "a string",
      42,
    ];
    for (const j of junk) expect(() => openSeal(OWNER, j as Snapshot)).not.toThrow();
    for (const j of junk) expect(openSeal(OWNER, j as Snapshot)).toBeNull();
  });

  describe("a copy signed with the right key that is still hostile", () => {
    const base = withoutOwner(review());
    const good = (mutate: (s: Record<string, any>) => void = () => undefined) => {
      const copy = JSON.parse(JSON.stringify(base));
      mutate(copy);
      return forge(OWNER, JSON.stringify(copy));
    };

    it("opens the unmodified review, so every refusal below is the check and not the helper", () => {
      expect(openSeal(OWNER, good())).toEqual({ ...base, userId: OWNER });
    });

    it("is refused when it inflates past the cap: a zip bomb is stopped, not built", () => {
      const bomb = forge(OWNER, Buffer.alloc(16 * 1024 * 1024, 0x61));
      expect(bomb.data.length).toBeLessThan(200_000); // it is small on the wire, which is the point
      expect(openSeal(OWNER, bomb)).toBeNull();
      expect(openSeal(OWNER, forge(OWNER, JSON.stringify({ ...base, pad: "x".repeat(1_200 * 1024) })))).toBeNull();
      // Just under the cap is a real review that happens to be big.
      expect(openSeal(OWNER, forge(OWNER, JSON.stringify({ ...base, pad: "x".repeat(900 * 1024) })))).not.toBeNull();
    });

    it("is refused when it is not deflate, not JSON, or not a review", () => {
      expect(openSeal(OWNER, { data: "AAAAAAAAAAAA", sig: signed(OWNER, "AAAAAAAAAAAA") })).toBeNull();
      expect(openSeal(OWNER, forge(OWNER, "this is not json"))).toBeNull();
      for (const value of ["null", "[]", '"text"', "42", "true", "{}"]) expect(openSeal(OWNER, forge(OWNER, value)), value).toBeNull();
    });

    it("is refused when the shape a reader depends on is missing or wrong", () => {
      const broken: Record<string, (s: Record<string, any>) => void> = {
        "id is not a UUID": (s) => (s.id = "../../etc/passwd"),
        "id is upper case": (s) => (s.id = String(s.id).toUpperCase()),
        "passages is not a list": (s) => (s.document.passages = {}),
        "sections is missing": (s) => delete s.document.sections,
        "document is missing": (s) => delete s.document,
        "claims is missing": (s) => delete s.claims,
        "claims is not a list": (s) => (s.claims = "none"),
        "timeline is not a list": (s) => (s.timeline = null),
        "challenges is missing": (s) => delete s.challenges,
        "mode is unknown": (s) => (s.mode = "ADMIN"),
        "status is unknown": (s) => (s.status = "paused"),
        "turnCounter is not a number": (s) => (s.turnCounter = "3"),
        "updatedAt is missing": (s) => delete s.updatedAt,
      };
      for (const [name, mutate] of Object.entries(broken)) expect(openSeal(OWNER, good(mutate)), name).toBeNull();
    });

    it("takes the owner from the caller, never from the copy", () => {
      const opened = openSeal(OWNER, good((s) => (s.userId = OTHER)));
      expect(opened?.userId).toBe(OWNER);
    });
  });

  describe("the signing key", () => {
    it("is the same on every instance that has the same secret, and only those", async () => {
      const sealed = sealSession(review());
      vi.resetModules();
      const other = await import("@/lib/redteam/seal"); // another process, as far as module state goes
      expect(other.openSeal(OWNER, sealed)).not.toBeNull();
      process.env.REDTEAM_SECRET = `${SECRET}-different`;
      expect(other.openSeal(OWNER, sealed)).toBeNull();
    });

    it("prefers REDTEAM_SECRET, then the voice key, then the database url", () => {
      process.env.ASSEMBLYAI_API_KEY = "assemblyai-key-0123456789abcdef";
      process.env.DATABASE_URL = "postgres://user:password@host.example/db";
      const sealed = sealSession(review());
      expect(sealed.sig).toBe(signed(OWNER, sealed.data, SECRET));

      delete process.env.REDTEAM_SECRET;
      const second = sealSession(review());
      expect(second.sig).toBe(signed(OWNER, second.data, "assemblyai-key-0123456789abcdef"));

      delete process.env.ASSEMBLYAI_API_KEY;
      const third = sealSession(review());
      expect(third.sig).toBe(signed(OWNER, third.data, "postgres://user:password@host.example/db"));
    });

    it("skips a secret too short to be safe", () => {
      process.env.REDTEAM_SECRET = "short";
      process.env.ASSEMBLYAI_API_KEY = "assemblyai-key-0123456789abcdef";
      const sealed = sealSession(review());
      expect(sealed.sig).toBe(signed(OWNER, sealed.data, "assemblyai-key-0123456789abcdef"));
    });

    it("is random for the process when nothing is configured, so a copy does not open elsewhere", async () => {
      delete process.env.REDTEAM_SECRET;
      const sealed = sealSession(review());
      expect(openSeal(OWNER, sealed)).not.toBeNull(); // this process can read its own
      vi.resetModules();
      const other = await import("@/lib/redteam/seal");
      expect(other.openSeal(OWNER, sealed)).toBeNull(); // another cannot: fails closed
    });
  });
});

describe("which copy of a review is newer", () => {
  const copy = (events: number, at: string) => ({ timeline: Array.from({ length: events }, () => ({})) as any[], updatedAt: at });

  it("goes by how much has happened, because clocks disagree between instances", () => {
    expect(isNewerCopy(copy(5, "2026-09-29T10:00:00.000Z"), copy(3, "2026-09-29T10:00:09.000Z"))).toBe(true);
    expect(isNewerCopy(copy(3, "2026-09-29T10:00:09.000Z"), copy(5, "2026-09-29T10:00:00.000Z"))).toBe(false);
  });

  it("breaks a tie with the later timestamp, and treats equals and nonsense as not newer", () => {
    expect(isNewerCopy(copy(4, "2026-09-29T10:00:02.000Z"), copy(4, "2026-09-29T10:00:01.000Z"))).toBe(true);
    expect(isNewerCopy(copy(4, "2026-09-29T10:00:01.000Z"), copy(4, "2026-09-29T10:00:01.000Z"))).toBe(false);
    expect(isNewerCopy(copy(4, "garbage"), copy(4, "2026-09-29T10:00:01.000Z"))).toBe(false);
    expect(revisionOf(copy(7, "x"))).toBe(7);
  });
});

describe("a failure to seal", () => {
  it("does not fail the request: the reply goes out without a copy and says nothing about the review", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = review();
    (s.document as any).title = {
      toJSON() {
        throw new Error("secret document text must not be logged");
      },
    };
    const out = reviewFields(s);
    expect(out.session.id).toBe(s.id);
    expect(out.snapshot).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(["redteam.seal.failed", "Error"]);
  });
});

/* ------------------------------------------------------------------ the routes */

describe("every response that carries a review carries a sealed copy of it", () => {
  it("covers create, load, tool, turn, typed and end, and each copy is the state after that call", async () => {
    const created = await start();
    const id = created.session.id;
    const raw: Record<string, string> = {};
    const bodies: Record<string, any> = { create: created };
    const take = async (name: string, res: Response) => {
      expect(res.status, name).toBe(200);
      raw[name] = await res.text();
      bodies[name] = JSON.parse(raw[name]);
    };
    await take("load", await LOAD(get(), ctx(id)));
    await take("tool", await tool(id, "retrieve_source", { query: "primary" }));
    await take("turn", await TURN(json({ sessionId: id, event: "reply_done" })));
    await take("typed", await TYPED(json({ sessionId: id, text: CONTRADICTED })));
    await take("end", await END(json({ sessionId: id })));
    await take("turnAfterEnd", await TURN(json({ sessionId: id, event: "interrupted" })));

    expect(Object.keys(bodies)).toHaveLength(7);
    for (const [name, body] of Object.entries(bodies)) {
      const opened = openSeal(`demo_${did}`, body.snapshot);
      expect(opened, name).not.toBeNull();
      expect(opened!.id, name).toBe(id);
      expect(opened!.claims, name).toEqual(body.session.claims);
      expect(opened!.timeline, name).toEqual(body.session.timeline);
      expect(opened!.status, name).toBe(body.session.status);
      expect(JSON.stringify(body), name).not.toContain(did);
    }
    expect(bodies.typed.session.claims).toHaveLength(1);
    expect(bodies.end.session.status).toBe("ended");
    expect(bodies.turnAfterEnd.changed).toBe(false);
  });

  it("does not give away the owner's cookie, in the copy or anywhere else in the response", async () => {
    const created = await start();
    const text = JSON.stringify(created);
    expect(text).not.toContain(did);
    expect(text).not.toContain(`demo_${did}`);
    const inflated = inflateRawSync(Buffer.from(created.snapshot.data, "base64url")).toString("utf8");
    expect(inflated).not.toContain(did);
  });
});

describe("restoring a review an instance has lost", () => {
  it("brings it back: the call 404s, the copy restores it, and the same call then works with the ledger intact", async () => {
    const created = await start();
    const id = created.session.id;
    const first = await (await claim(id, CONTRADICTED)).json();
    expect(first.result.status).toBe("CONTRADICTED");

    newInstance();
    const missed = await tool(id, "retrieve_source", { query: "primary" });
    expect(missed.status).toBe(404);
    expect((await missed.json()).error.code).toBe("SESSION_NOT_FOUND");

    const back = await RESTORE(json({ snapshot: first.snapshot }));
    expect(back.status).toBe(200);
    expect(back.headers.get("cache-control")).toBe("no-store");
    const restored = await back.json();
    expect(restored.session).toEqual(first.session); // ledger, timeline, document, challenges: exactly as the server left them
    expect(openSeal(`demo_${did}`, restored.snapshot)).toEqual(await getSession(`demo_${did}`, id));

    const next = await claim(id, SUPPORTED);
    expect(next.status).toBe(200);
    const after = await next.json();
    expect(after.session.claims).toHaveLength(2);
    expect(after.session.claims[0]).toEqual(first.session.claims[0]); // the earlier verdict is what the server gave, untouched
    expect(after.session.claims[1].status).toBe("SUPPORTED");
    expect(after.session.timeline.length).toBeGreaterThan(first.session.timeline.length);
  });

  it("saves it, so a plain reload works afterwards with no copy in hand", async () => {
    const created = await start();
    const id = created.session.id;
    const first = await (await claim(id, CONTRADICTED)).json();
    newInstance();
    expect((await LOAD(get(), ctx(id))).status).toBe(404);
    expect((await RESTORE(json({ snapshot: first.snapshot }))).status).toBe(200);
    const load = await LOAD(get(), ctx(id));
    expect(load.status).toBe(200);
    const body = await load.json();
    expect(body.session.claims).toHaveLength(1);
    expect(body.voice.greeting).toMatch(/^Picking up where we left off/);
  });

  it("restores a review that had already ended, still ended", async () => {
    const created = await start();
    const id = created.session.id;
    await claim(id, SUPPORTED);
    const ended = await (await END(json({ sessionId: id }))).json();
    newInstance();
    const back = await (await RESTORE(json({ snapshot: ended.snapshot }))).json();
    expect(back.session.status).toBe("ended");
    const late = await (await claim(id, CONTRADICTED)).json();
    expect(late.isError).toBe(true);
    expect(late.session.claims).toHaveLength(1);
  });

  it("keeps the copy an instance already holds when that one is newer, and hands that back", async () => {
    const created = await start();
    const id = created.session.id;
    const behind = created.snapshot; // one event old
    const ahead = await (await claim(id, CONTRADICTED)).json();

    const res = await RESTORE(json({ snapshot: behind }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.claims).toHaveLength(1);
    expect(body.session).toEqual(ahead.session);
    expect(openSeal(`demo_${did}`, body.snapshot)!.claims).toHaveLength(1);
    expect((await getSession(`demo_${did}`, id))!.claims).toHaveLength(1); // nothing was rolled back
  });

  it("answers a stale copy of an instance the browser has moved past as 'not here', so it is restored and not forked", async () => {
    const created = await start();
    const id = created.session.id;
    const older = created.snapshot;
    const ahead = await (await claim(id, CONTRADICTED)).json();
    const seen = String(ahead.session.timeline.length);
    const ghost = await ghostBody();

    // This instance goes back to holding the older copy, as one that missed a call would.
    await saveSession(openSeal(`demo_${did}`, older)!);
    const refused = await claim(id, SUPPORTED, { "x-redteam-rev": seen });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(ghost);
    expect((await getSession(`demo_${did}`, id))!.claims).toHaveLength(0); // nothing ran on the stale copy

    expect((await RESTORE(json({ snapshot: ahead.snapshot }))).status).toBe(200);
    const ok = await claim(id, SUPPORTED, { "x-redteam-rev": seen });
    expect(ok.status).toBe(200);
    const after = await ok.json();
    expect(after.session.claims.map((c: any) => c.status)).toEqual(["CONTRADICTED", "SUPPORTED"]);
  });

  it("only ever lets the revision hint refuse a call: a hint that is behind, missing or nonsense changes nothing", async () => {
    const created = await start();
    const id = created.session.id;
    const have = created.session.timeline.length;
    for (const value of [String(have), String(have - 1), "0", "abc", "-1", "1.5", "", "12345678"]) {
      const res = await tool(id, "retrieve_source", { query: "primary" }, { "x-redteam-rev": value });
      expect(res.status, `rev ${JSON.stringify(value)}`).toBe(200);
    }
    // A caller who says they have seen more than exists is only refused, with the ordinary answer.
    const liar = await tool(id, "retrieve_source", { query: "primary" }, { "x-redteam-rev": String(have + 50) });
    expect(liar.status).toBe(404);
    expect(await liar.json()).toEqual(await ghostBody());
  });
});

describe("a restore is not a way to ask questions", () => {
  it("answers another browser's copy exactly as it answers a review that never existed, and saves nothing", async () => {
    const created = await start();
    const id = created.session.id;
    const first = await (await claim(id, CONTRADICTED)).json();
    newInstance();
    const ghost = await ghostBody();

    did = "7c".repeat(16);
    const res = await RESTORE(json({ snapshot: first.snapshot }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(ghost);
    expect(await getSession(`demo_${did}`, id)).toBeNull();
    did = "5e".repeat(16);
    expect(await getSession(`demo_${did}`, id)).toBeNull();
  });

  it("answers a tampered copy, a copy sealed for someone else, an expired copy and noise the same way", async () => {
    const created = await start();
    const id = created.session.id;
    const first = await (await claim(id, CONTRADICTED)).json();
    newInstance();
    const ghost = await ghostBody();

    const expired = review(`demo_${did}`);
    expired.updatedAt = new Date(Date.now() - 7 * 3_600_000).toISOString();
    const elsewhere = sealSession(review(OTHER));
    const cases: Record<string, Snapshot> = {
      "a changed byte": { data: flip(first.snapshot.data, 10), sig: first.snapshot.sig },
      "a changed signature": { data: first.snapshot.data, sig: flip(first.snapshot.sig, 3) },
      "another owner's copy": elsewhere,
      "an expired copy": sealSession(expired),
      "noise": { data: "AAAAAAAAAAAAAAAA", sig: "BBBBBBBBBBBBBBBB" },
      "a bomb": forge(`demo_${did}`, Buffer.alloc(16 * 1024 * 1024, 0x61)),
    };
    for (const [name, snapshot] of Object.entries(cases)) {
      const res = await RESTORE(json({ snapshot }));
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual(ghost);
    }
    expect(await getSession(`demo_${did}`, id)).toBeNull();
  });

  it("refuses a body that is not exactly a snapshot before it looks at any signature", async () => {
    const created = await start();
    const good = created.snapshot;
    const bad: unknown[] = [
      {},
      { snapshot: "x" },
      { snapshot: null },
      { snapshot: { data: good.data } },
      { snapshot: { sig: good.sig } },
      { snapshot: { ...good, extra: 1 } },
      { snapshot: good, admin: true },
      { snapshot: { data: 5, sig: good.sig } },
      { snapshot: { data: "not base64!", sig: good.sig } },
      { snapshot: { data: good.data, sig: "s".repeat(65) } },
      { snapshot: { data: "", sig: good.sig } },
      { snapshot: { data: "a".repeat(MAX_SNAPSHOT_CHARS + 1), sig: good.sig } },
    ];
    for (const body of bad) expect((await RESTORE(json(body))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect((await RESTORE(new Request("http://localhost/x", { method: "POST", body: "{not json" }))).status).toBe(400);
    const huge = await RESTORE(json({ snapshot: { data: "a".repeat(MAX_SNAPSHOT_CHARS + 5_000), sig: good.sig } }));
    expect(huge.status).toBe(413);
  });

  it("is rate limited like the other calls a review makes", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await RESTORE(json({ snapshot: { data: "AAAA", sig: "BBBB" } }));
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- the browser side */

/** A scripted server: each call gets the next answer, and every call is recorded. */
type Call = { url: string; method: string; body: any; headers: Headers };
type Step = Response | ((call: Call) => Response | Promise<Response>);

function scripted(steps: Step[]): Call[] {
  const calls: Call[] = [];
  let next = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const step = steps[next++];
    if (!step) throw new Error(`unscripted call ${calls.length}: ${call.method} ${call.url}`);
    return typeof step === "function" ? step(call) : step;
  }) as typeof fetch;
  return calls;
}

const ID = "11111111-1111-4111-8111-111111111111";
const snap = (tag: string): Snapshot => ({ data: `data-${tag}`, sig: `sig-${tag}` });
const reviewOf = (events: number, tag: string, id = ID) => ({ session: { id, timeline: Array.from({ length: events }, () => ({})), claims: [] }, snapshot: snap(tag) });
const ok = (body: unknown, status = 200) => Response.json(body, { status });
const gone = () => Response.json({ error: { code: "SESSION_NOT_FOUND", message: "That review is not here any more. Start a new one.", retryable: false } }, { status: 404 });
const fails = (status: number, code: string) => Response.json({ error: { code, message: `plain words for ${code}`, retryable: false } }, { status });

/** Start a review through the client so it holds the first copy. */
async function opened(tag = "A", events = 1) {
  const calls = scripted([ok({ ...reviewOf(events, tag), voice: {} }, 201)]);
  await createReview({ mode: "SKEPTIC", sample: true });
  return calls;
}

const useTool = () => httpApi.tool(ID, "retrieve_source", { query: "x" }, "call-1");

describe("the browser restores once and retries once", () => {
  it("restores a review the server lost, sends the held copy, and repeats the call once", async () => {
    await opened("A", 1);
    const calls = scripted([gone(), ok(reviewOf(1, "B")), ok({ result: { found: true }, isError: false, ...reviewOf(2, "C") })]);
    const out = await useTool();

    expect(calls.map((c) => c.url)).toEqual(["/api/redteam/tool", "/api/redteam/session/restore", "/api/redteam/tool"]);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toEqual({ snapshot: snap("A") }); // exactly the copy, and nothing else
    expect(calls[2].body).toEqual(calls[0].body); // the same call, not a new one
    expect(out.result).toEqual({ found: true });
  });

  it("holds the latest copy of each review and restores from that one", async () => {
    await opened("A", 1);
    scripted([ok({ result: {}, isError: false, ...reviewOf(3, "B") })]);
    await useTool();
    scripted([ok({ result: {}, isError: false, ...reviewOf(5, "C") })]);
    await useTool();

    const calls = scripted([gone(), ok(reviewOf(5, "C")), ok({ result: {}, isError: false, ...reviewOf(6, "D") })]);
    await useTool();
    expect(calls[1].body).toEqual({ snapshot: snap("C") });
  });

  it("does not let an answer that arrives late put an older copy back", async () => {
    await opened("A", 1);
    let releaseOlder: (r: Response) => void = () => undefined;
    scripted([
      () => new Promise<Response>((resolve) => (releaseOlder = resolve)),
      () => ok({ result: {}, isError: false, ...reviewOf(5, "NEWER") }),
    ]);
    const slow = useTool(); // asked first, answers last
    await httpApi.turn(ID, "reply_done");
    releaseOlder(ok({ result: {}, isError: false, ...reviewOf(3, "OLDER") }));
    await slow;

    const calls = scripted([gone(), ok(reviewOf(5, "NEWER")), ok({ result: {}, isError: false, ...reviewOf(6, "NEXT") })]);
    await useTool();
    expect(calls[1].body).toEqual({ snapshot: snap("NEWER") });
  });

  it("keeps a copy per review and never restores one review with another's", async () => {
    const OTHER_ID = "22222222-2222-4222-8222-222222222222";
    await opened("A", 1);
    scripted([ok({ ...reviewOf(1, "Z", OTHER_ID), voice: {} }, 201)]);
    await createReview({ mode: "SKEPTIC", sample: true });

    const calls = scripted([gone(), ok(reviewOf(1, "A")), ok({ result: {}, isError: false, ...reviewOf(2, "A2") })]);
    await useTool();
    expect(calls[1].body).toEqual({ snapshot: snap("A") });
  });

  it("does nothing extra when it holds no copy: the plain error, one call", async () => {
    const calls = scripted([gone()]);
    await expect(useTool()).rejects.toThrow("That review is not here any more. Start a new one.");
    expect(calls).toHaveLength(1);
  });

  it("restores for that answer and no other error", async () => {
    const others: [number, string][] = [
      [500, "REDTEAM_UNAVAILABLE"],
      [429, "RATE_LIMITED"],
      [400, "BAD_REQUEST"],
      [409, "ENDED"],
      [413, "TOO_LARGE"],
      [404, "NOT_FOUND"], // a 404 that is not the review being gone
    ];
    for (const [status, code] of others) {
      __resetSnapshots();
      await opened("A", 1);
      const calls = scripted([fails(status, code)]);
      await expect(useTool(), code).rejects.toThrow(`plain words for ${code}`);
      expect(calls, code).toHaveLength(1);
    }
    __resetSnapshots();
    await opened("A", 1);
    const calls = scripted([new Response("<html>not found</html>", { status: 404 })]);
    await expect(useTool()).rejects.toThrow("That did not go through.");
    expect(calls).toHaveLength(1);
  });

  it("never retries more than once: a second 'not here' is the answer", async () => {
    await opened("A", 1);
    const calls = scripted([gone(), ok(reviewOf(1, "A")), gone()]);
    await expect(useTool()).rejects.toThrow("That review is not here any more. Start a new one.");
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.url.endsWith("/restore"))).toHaveLength(1);
  });

  it("surfaces the original error, and does not repeat the call, when the restore fails", async () => {
    const failures: Record<string, Step> = {
      "refused": gone(),
      "server error": fails(500, "REDTEAM_UNAVAILABLE"),
      "rate limited": fails(429, "RATE_LIMITED"),
      "not json": new Response("nope", { status: 200 }),
      "a different review": ok(reviewOf(1, "X", "33333333-3333-4333-8333-333333333333")),
      "the network": () => {
        throw new TypeError("Failed to fetch");
      },
    };
    for (const [name, step] of Object.entries(failures)) {
      __resetSnapshots();
      await opened("A", 1);
      const calls = scripted([gone(), step]);
      await expect(useTool(), name).rejects.toThrow("That review is not here any more. Start a new one.");
      expect(calls, name).toHaveLength(2);
    }
  });

  it("does not restore from a copy that a later reply without one made out of date", async () => {
    await opened("A", 1);
    scripted([ok({ result: {}, isError: false, session: reviewOf(2, "-").session })]); // a reply with no copy in it
    await useTool();
    const calls = scripted([gone()]);
    await expect(useTool()).rejects.toThrow("That review is not here any more. Start a new one.");
    expect(calls).toHaveLength(1);
  });

  it("says how far it has seen the review, once it holds a copy, and only about that review", async () => {
    const start = await opened("A", 4);
    expect(start[0].headers.get("x-redteam-rev")).toBeNull();
    const calls = scripted([
      ok({ result: {}, isError: false, ...reviewOf(6, "B") }),
      ok({ result: {}, isError: false, ...reviewOf(6, "B", "44444444-4444-4444-8444-444444444444") }),
    ]);
    await useTool();
    await httpApi.tool("44444444-4444-4444-8444-444444444444", "retrieve_source", {}, "c2");
    expect(calls[0].headers.get("x-redteam-rev")).toBe("4");
    expect(calls[1].headers.get("x-redteam-rev")).toBeNull();
  });

  it("loads a review with the same restore, and says nothing is there when no copy is held", async () => {
    const none = scripted([gone()]);
    expect(await loadReview(ID)).toBeNull();
    expect(none).toHaveLength(1);

    await opened("A", 2);
    const calls = scripted([gone(), ok(reviewOf(2, "A")), ok({ ...reviewOf(2, "A"), voice: { greeting: "Picking up where we left off." } })]);
    const back = await loadReview(ID);
    expect(back?.voice).toEqual({ greeting: "Picking up where we left off." });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /api/redteam/session/${ID}`, "POST /api/redteam/session/restore", `GET /api/redteam/session/${ID}`]);
    expect(calls[0].headers.get("x-redteam-rev")).toBe("2");
  });

  it("shares one restore between calls that both find the review gone", async () => {
    await opened("A", 1);
    // The restore is held open until both calls are waiting on it, so what is
    // asserted does not depend on how the runtime orders its microtasks.
    let release: (r: Response) => void = () => undefined;
    const calls = scripted([
      gone(),
      gone(),
      () => new Promise<Response>((resolve) => (release = resolve)),
      ok({ result: {}, isError: false, ...reviewOf(2, "B") }),
      ok({ result: {}, isError: false, ...reviewOf(3, "C") }),
    ]);
    const first = useTool();
    const second = httpApi.turn(ID, "reply_done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((c) => c.url.endsWith("/restore"))).toHaveLength(1);
    release(ok(reviewOf(1, "A")));
    await Promise.all([first, second]);
    expect(calls).toHaveLength(5); // two calls, one restore, two repeats
  });

  describe("across a reload", () => {
    function fakeStorage() {
      const kept = new Map<string, string>();
      vi.stubGlobal("sessionStorage", {
        getItem: (k: string) => kept.get(k) ?? null,
        setItem: (k: string, v: string) => void kept.set(k, v),
        removeItem: (k: string) => void kept.delete(k),
      });
      return kept;
    }

    it("keeps the current review's copy for the tab, so resume can restore after the page is reloaded", async () => {
      const kept = fakeStorage();
      await opened("A", 3);
      expect(JSON.parse([...kept.values()][0])).toEqual({ id: ID, snapshot: snap("A"), rev: 3 });

      __resetSnapshots(); // the page reloads: memory is gone, the tab's storage is not
      const calls = scripted([gone(), ok(reviewOf(3, "A")), ok({ ...reviewOf(3, "A"), voice: { greeting: "Picking up where we left off." } })]);
      const back = await loadReview(ID);
      expect(back?.session.id).toBe(ID);
      expect(calls[0].headers.get("x-redteam-rev")).toBe("3");
      expect(calls[1].body).toEqual({ snapshot: snap("A") });
    });

    it("forgets it when a reply arrives with no copy, so an older one is never restored", async () => {
      const kept = fakeStorage();
      await opened("A", 3);
      scripted([ok({ result: {}, isError: false, session: reviewOf(4, "-").session })]);
      await useTool();
      expect(kept.size).toBe(0);
    });

    it("is only a convenience: storage that refuses everything changes nothing", async () => {
      vi.stubGlobal("sessionStorage", {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      });
      await opened("A", 1);
      const calls = scripted([gone(), ok(reviewOf(1, "A")), ok({ result: {}, isError: false, ...reviewOf(2, "B") })]);
      await expect(useTool()).resolves.toMatchObject({ isError: false });
      expect(calls).toHaveLength(3);
    });
  });
});

describe("the browser and the routes together", () => {
  /** The real route handlers behind a fetch, the way the browser reaches them. */
  function serve(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const req = new Request(url, init);
      const p = url.pathname;
      if (p === "/api/redteam/session/restore") return RESTORE(req);
      if (p === "/api/redteam/session") return CREATE(req);
      const one = /^\/api\/redteam\/session\/([^/]+)$/.exec(p);
      if (one) return LOAD(req, ctx(decodeURIComponent(one[1])));
      const routes: Record<string, (r: Request) => Promise<Response>> = {
        "/api/redteam/tool": TOOL,
        "/api/redteam/turn": TURN,
        "/api/redteam/typed": TYPED,
        "/api/redteam/end": END,
      };
      const route = routes[p];
      if (!route) throw new Error(`unrouted ${p}`);
      return route(req);
    }) as typeof fetch;
  }

  const say = (id: string, spoken: string) => httpApi.tool(id, "evaluate_spoken_claim", { spoken_text: spoken }, `c-${spoken.length}`);

  it("a call that lands on an instance that never heard of the review just works, and runs once", async () => {
    serve();
    const { session } = await createReview({ mode: "SKEPTIC", sample: true });
    const first = await say(session.id, CONTRADICTED);
    expect(first.result.status).toBe("CONTRADICTED");

    newInstance();
    const next = await say(session.id, SUPPORTED);
    expect(next.result.status).toBe("SUPPORTED");
    expect(next.session.claims.map((c) => c.status)).toEqual(["CONTRADICTED", "SUPPORTED"]);
    expect(next.session.claims[0]).toEqual(first.session.claims[0]);
    // Repeating the call after the restore did not run it twice.
    expect(next.session.claims).toHaveLength(2);
  });

  it("a call that lands on an instance holding an older copy is restored over it and does not fork the review", async () => {
    serve();
    const { session } = await createReview({ mode: "SKEPTIC", sample: true });
    const early = await getSession(`demo_${did}`, session.id);
    const snapshotOfEarly = structuredClone(early!);
    await say(session.id, CONTRADICTED);
    await httpApi.typed(session.id, { next: true });

    // The instance that answers next only ever saw the review as it was at the start.
    await saveSession(snapshotOfEarly);
    const next = await say(session.id, SUPPORTED);
    expect(next.session.claims.map((c) => c.status)).toEqual(["CONTRADICTED", "SUPPORTED"]);
    expect(next.session.challenges.length).toBeGreaterThan(snapshotOfEarly.challenges.length);
    expect((await getSession(`demo_${did}`, session.id))!.claims).toHaveLength(2);
  });

  it("resumes a review after the instance changed, using the same restore", async () => {
    serve();
    const { session } = await createReview({ mode: "SKEPTIC", sample: true });
    await say(session.id, CONTRADICTED);
    newInstance();
    const back = await loadReview(session.id);
    expect(back?.session.claims).toHaveLength(1);
    expect(back?.voice.greeting).toMatch(/^Picking up where we left off/);
  });

  it("does not restore anything for a review that was never made or belongs to someone else", async () => {
    serve();
    const { session } = await createReview({ mode: "SKEPTIC", sample: true });
    await say(session.id, CONTRADICTED);
    newInstance();
    did = "9d".repeat(16); // a different browser, holding the first browser's copy in this page's memory
    await expect(say(session.id, SUPPORTED)).rejects.toThrow("That review is not here any more. Start a new one.");
    expect(await getSession(`demo_${did}`, session.id)).toBeNull();
    did = "5e".repeat(16);
    expect(await getSession(`demo_${did}`, session.id)).toBeNull();
  });
});
