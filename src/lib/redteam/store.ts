import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RedteamSession } from "./types";

/**
 * Where live sessions sit.
 *
 * In memory, written through to the temp directory so a reload, a dev-server
 * restart, or a second worker on the same disk can pick a review back up. It
 * is NOT a database and this file does not pretend otherwise: on a serverless
 * host each instance has its own disk and a session can vanish between two
 * requests. The demo runs on one long-lived process; the README says so.
 *
 * Ownership is enforced here and nowhere else. `get` takes the user id and
 * returns nothing for a session that belongs to someone else — the same answer
 * as for a session that does not exist, so an id cannot be probed.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 300;
const ID = /^[0-9a-f-]{36}$/;

const live = new Map<string, RedteamSession>();

function dir(): string {
  return process.env.REDTEAM_DIR ?? path.join(os.tmpdir(), "viva-redteam");
}

function file(id: string): string {
  return path.join(dir(), `${id}.json`);
}

function fresh(s: RedteamSession): boolean {
  return Date.now() - Date.parse(s.updatedAt) < TTL_MS;
}

export function saveSession(s: RedteamSession): void {
  live.set(s.id, s);
  if (live.size > MAX_SESSIONS) {
    const oldest = [...live.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))[0];
    if (oldest) live.delete(oldest.id);
  }
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${file(s.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file(s.id));
  } catch {
    // Memory still holds it. Losing the write-through loses recovery, not the review.
  }
}

export function getSession(userId: string, id: string): RedteamSession | null {
  if (!ID.test(id)) return null;
  let s = live.get(id) ?? null;
  if (!s) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(id), "utf8")) as RedteamSession;
      if (parsed && parsed.id === id && Array.isArray(parsed.claims) && parsed.document?.passages) {
        s = parsed;
        live.set(id, s);
      }
    } catch {
      return null;
    }
  }
  if (!s || s.userId !== userId || !fresh(s)) return null;
  return s;
}

export function deleteSession(userId: string, id: string): boolean {
  const s = getSession(userId, id);
  if (!s) return false;
  live.delete(id);
  try {
    fs.rmSync(file(id), { force: true });
  } catch {
    // Already gone.
  }
  return true;
}

/** Test seam. */
export function __resetSessions(): void {
  live.clear();
}
