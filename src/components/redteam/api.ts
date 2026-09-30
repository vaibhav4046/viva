import type { Api } from "@/lib/redteam/controller";
import { voiceMessage } from "@/lib/audio/messages";

/** The browser's side of the RedTeam API. Every call goes to our own origin. */

/*
 * A review can outlive the server instance that holds it.
 *
 * Without a database a review sits in one instance's memory, and a serverless
 * host is free to send the next request to another. That instance answers
 * SESSION_NOT_FOUND in the middle of a review. Every response therefore carries
 * a sealed copy of the review (see lib/redteam/seal.ts), which is kept here.
 * When a call comes back SESSION_NOT_FOUND and a copy is held, the copy is sent
 * to /api/redteam/session/restore and the call is made once more.
 *
 * The copy is opaque and signed by the server. Holding it lets this page bring
 * a review back; it does not let this page write one, and nothing here reads
 * inside it.
 */

type Snapshot = { data: string; sig: string };

/** `rev` is how many timeline events the review had when the copy was made. */
type Held = { snapshot: Snapshot; rev: number };

type Reply = { res: Response; json: any };

/**
 * Sent with every call about a review a copy is held for, saying how far the
 * page has seen it. An instance holding an older copy then answers "not here"
 * instead of answering from a review that is behind, and that is what sends the
 * page to restore. Same name as in lib/redteam/http.ts; that file cannot be
 * imported here because it reads cookies and the store.
 */
const REVISION_HEADER = "x-redteam-rev";

/** Reviews this page keeps a copy for. A page works on one at a time; the rest is a bound, not a feature. */
const MAX_HELD = 6;

/** Where the copy of the review this tab is on is also kept, so a reload can restore it. */
const SLOT = "viva.redteam.snapshot";

const held = new Map<string, Held>();
const restoring = new Map<string, Promise<boolean>>();

const isSnapshot = (x: unknown): x is Snapshot =>
  Boolean(x) && typeof (x as Snapshot).data === "string" && typeof (x as Snapshot).sig === "string";

/*
 * The copy is also kept in sessionStorage, for the tab's single current review.
 * A reload empties the Map above, and the app's "resume" runs right after a
 * reload, which is the moment a different instance is most likely to answer. It
 * is sessionStorage, not localStorage, so the review's text is gone when the
 * tab is. Storage blocked or full only costs that: restore still works for
 * every call made without a reload.
 */
function stash(id: string, h: Held): void {
  try {
    sessionStorage.setItem(SLOT, JSON.stringify({ id, snapshot: h.snapshot, rev: h.rev }));
  } catch {
    // Blocked, full, or not a browser.
  }
}

function unstash(id: string): void {
  try {
    if (JSON.parse(sessionStorage.getItem(SLOT) ?? "null")?.id === id) sessionStorage.removeItem(SLOT);
  } catch {
    // Nothing kept, or storage blocked.
  }
}

function stashed(id: string): Held | undefined {
  try {
    const kept = JSON.parse(sessionStorage.getItem(SLOT) ?? "null");
    if (kept?.id === id && isSnapshot(kept.snapshot) && Number.isInteger(kept.rev)) return { snapshot: kept.snapshot, rev: kept.rev };
  } catch {
    // Nothing kept, or storage blocked.
  }
  return undefined;
}

function recall(id: string): Held | undefined {
  return held.get(id) ?? stashed(id);
}

/** Take the copy out of a response that has one. */
function keep(json: unknown): void {
  const body = json as { session?: { id?: unknown; timeline?: unknown }; snapshot?: unknown } | null;
  const id = body?.session?.id;
  const timeline = body?.session?.timeline;
  if (typeof id !== "string" || !Array.isArray(timeline)) return;
  const snapshot = body?.snapshot;
  if (!isSnapshot(snapshot)) {
    // A reply about a review that carries no copy leaves nothing current to
    // restore from, and an older copy would quietly move the review backwards.
    held.delete(id);
    unstash(id);
    return;
  }
  const rev = timeline.length;
  // An answer that arrives after a newer one (the end call is not queued behind
  // the others) must not put an older copy back.
  if ((held.get(id)?.rev ?? -1) > rev) return;
  const next = { snapshot, rev };
  held.delete(id);
  held.set(id, next);
  while (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
  stash(id, next);
}

/** One call, with the page's revision hint on it when a copy is held. A response with a review in it refreshes the copy. */
async function exchange(url: string, init: RequestInit, id: string | null): Promise<Reply> {
  const mine = id ? recall(id) : undefined;
  const headers = new Headers(init.headers);
  if (mine) headers.set(REVISION_HEADER, String(mine.rev));
  const res = await fetch(url, { ...init, headers });
  const json = await res.json().catch(() => null);
  if (res.ok) keep(json);
  return { res, json };
}

/** Only this answer means "the server no longer has the review". A 429 or a 500 says nothing about that. */
const lost = ({ res, json }: Reply): boolean => res.status === 404 && json?.error?.code === "SESSION_NOT_FOUND";

/** Send the held copy back. True only if the server took it and returned this same review. Never throws. */
function restore(id: string): Promise<boolean> {
  const running = restoring.get(id);
  if (running) return running;
  const attempt = (async () => {
    const mine = recall(id);
    if (!mine) return false;
    try {
      const res = await fetch("/api/redteam/session/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: mine.snapshot }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.session?.id !== id) return false;
      keep(json);
      return true;
    } catch {
      return false;
    }
  })().finally(() => restoring.delete(id));
  restoring.set(id, attempt);
  return attempt;
}

/**
 * Make a call; if the server has lost the review and a copy is held, restore it
 * and make the same call once more. Once, and only for that one answer: the
 * second answer, whatever it is, is the answer. Repeating is safe because these
 * routes look the review up before they do anything, so a "not found" means the
 * call did nothing.
 */
async function withRestore(id: string | null, attempt: () => Promise<Reply>): Promise<Reply> {
  const first = await attempt();
  if (!id || !lost(first) || !recall(id)) return first;
  if (!(await restore(id))) return first;
  return attempt();
}

async function post<T>(url: string, body: unknown, id: string | null = null): Promise<T> {
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const { res, json } = await withRestore(id, () => exchange(url, init, id));
  if (!res.ok || !json) throw new Error(json?.error?.message ?? "That did not go through.");
  return json as T;
}

/** Test seam: forget every held copy, as a fresh page load does. */
export function __resetSnapshots(): void {
  held.clear();
  restoring.clear();
}

/** Mint a Voice Agent token from our own origin. The permanent key never comes with it. */
export async function mintToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/voice-agent/token", { cache: "no-store" });
  } catch {
    throw new Error(voiceMessage("NETWORK_DOWN"));
  }
  const body = (await res.json().catch(() => null)) as { token?: string; error?: { code?: string } } | null;
  if (!res.ok || typeof body?.token !== "string") throw new Error(voiceMessage(body?.error?.code ?? "NO_API_KEY"));
  return body.token;
}

export const httpApi: Api = {
  token: mintToken,
  tool: (sessionId, name, args, callId) => post("/api/redteam/tool", { sessionId, name, callId, arguments: args }, sessionId),
  turn: (sessionId, event, text) => post("/api/redteam/turn", { sessionId, event, ...(text ? { text } : {}) }, sessionId),
  typed: (sessionId, body) => post("/api/redteam/typed", { sessionId, ...body }, sessionId),
  end: (sessionId) => post("/api/redteam/end", { sessionId }, sessionId),
};

export async function createReview(input: { mode: string; sample: boolean; title?: string; text?: string }) {
  return post<{ session: import("@/lib/redteam/controller").SessionView; voice: import("@/lib/redteam/controller").VoiceConfig }>("/api/redteam/session", input);
}

export async function loadReview(id: string) {
  const { res, json } = await withRestore(id, () => exchange(`/api/redteam/session/${encodeURIComponent(id)}`, { cache: "no-store" }, id));
  if (!res.ok || !json) return null;
  return json as { session: import("@/lib/redteam/controller").SessionView; voice: import("@/lib/redteam/controller").VoiceConfig };
}
