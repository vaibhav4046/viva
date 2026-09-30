import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbQuery, isDbConfigured } from "@/lib/db/db";
import { serverLog } from "@/lib/observe";
import type { RedteamSession } from "./types";

/**
 * Where live sessions sit.
 *
 * With DATABASE_URL set, Postgres holds them (table `redteam_sessions`) and is
 * read on every request: a serverless deployment has no single process, so a
 * cache would serve one instance a stale ledger. If the database cannot be
 * reached the review falls back to this instance's memory and temp directory
 * and keeps going, and says so in the server log; on a serverless host that
 * fallback can lose a session between two requests.
 *
 * Without DATABASE_URL (local, `next start`, Docker) it is memory written
 * through to the temp directory, so a reload or a restart can pick a review
 * back up.
 *
 * Ownership is enforced here and nowhere else. `get` takes the user id and
 * returns nothing for a session that belongs to someone else — the same answer
 * as for a session that does not exist, so an id cannot be probed.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 300;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ensured ??= dbQuery(
    "CREATE TABLE IF NOT EXISTS redteam_sessions (id UUID PRIMARY KEY, user_id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  )
    .then(() => undefined)
    .catch((e) => {
      ensured = null;
      throw e;
    });
  return ensured;
}

let lastSweep = 0;

/** Delete session files past their TTL. Without this /tmp fills up: expiry was only ever checked on read. */
function sweep(): void {
  if (Date.now() - lastSweep < 10 * 60_000) return;
  lastSweep = Date.now();
  try {
    // The directory is the OS temp dir, never project files; without this
    // comment Turbopack traces the whole project into the server bundle.
    for (const name of fs.readdirSync(/*turbopackIgnore: true*/ dir())) {
      const f = path.join(dir(), name);
      if (Date.now() - fs.statSync(f).mtimeMs > TTL_MS) fs.rmSync(f, { force: true });
    }
  } catch {
    // Nothing to sweep, or a file vanished underneath us.
  }
}

function writeLocal(s: RedteamSession): void {
  sweep();
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

function readLocal(userId: string, id: string): RedteamSession | null {
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

export async function saveSession(s: RedteamSession): Promise<void> {
  if (isDbConfigured()) {
    try {
      await ensureTable();
      await dbQuery(
        "INSERT INTO redteam_sessions (id, user_id, data, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() WHERE redteam_sessions.user_id = EXCLUDED.user_id",
        [s.id, s.userId, JSON.stringify(s)]
      );
      return;
    } catch (e) {
      serverLog("redteam.store.pg_write_failed", "-", { message: (e as Error).message?.slice(0, 160) });
    }
  }
  writeLocal(s);
}

export async function getSession(userId: string, id: string): Promise<RedteamSession | null> {
  if (!ID.test(id)) return null;
  if (isDbConfigured()) {
    try {
      await ensureTable();
      const rows = await dbQuery<{ data: RedteamSession }>(
        "SELECT data FROM redteam_sessions WHERE id = $1 AND user_id = $2 AND updated_at > now() - interval '6 hours'",
        [id, userId]
      );
      const s = rows[0]?.data;
      if (s && s.id === id && s.userId === userId) return s;
      // Not in the database. It may still be in this instance's memory if an
      // earlier write fell back; ownership is checked there too.
      return readLocal(userId, id);
    } catch (e) {
      serverLog("redteam.store.pg_read_failed", "-", { message: (e as Error).message?.slice(0, 160) });
    }
  }
  return readLocal(userId, id);
}

export async function deleteSession(userId: string, id: string): Promise<boolean> {
  const s = await getSession(userId, id);
  if (!s) return false;
  live.delete(id);
  try {
    fs.rmSync(file(id), { force: true });
  } catch {
    // Already gone.
  }
  if (isDbConfigured()) {
    try {
      await ensureTable();
      await dbQuery("DELETE FROM redteam_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
    } catch (e) {
      serverLog("redteam.store.pg_delete_failed", "-", { message: (e as Error).message?.slice(0, 160) });
      return false;
    }
  }
  return true;
}

/** Test seam. */
export function __resetSessions(): void {
  live.clear();
  ensured = null;
}
