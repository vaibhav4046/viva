import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Postgres side of RedTeam session storage, against a fake `pg` that
 * actually stores rows and honours the parameters it is given.
 *
 * What this can show: every statement is scoped by user_id, one user cannot
 * read or delete another's session, a failing database degrades to this
 * instance instead of ending the review, and the table is created on first use.
 * What it cannot show: how a real Postgres behaves. See store-pg-isolation for
 * the same caveat.
 */

const db = vi.hoisted(() => ({
  rows: new Map<string, { user_id: string; data: string }>(),
  log: [] as { sql: string; params: unknown[] }[],
  fail: false,
}));

vi.mock("pg", () => {
  class Pool {
    on() {}
    async query(sql: string, params: unknown[] = []) {
      db.log.push({ sql, params });
      if (db.fail) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      if (/^CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^INSERT INTO redteam_sessions/i.test(sql)) {
        const [id, user, data] = params as string[];
        const cur = db.rows.get(id);
        if (!cur || cur.user_id === user) db.rows.set(id, { user_id: user, data });
        return { rows: [] };
      }
      if (/^SELECT data FROM redteam_sessions/i.test(sql)) {
        const [id, user] = params as string[];
        const r = db.rows.get(id);
        return { rows: r && r.user_id === user ? [{ data: JSON.parse(r.data) }] : [] };
      }
      if (/^DELETE FROM redteam_sessions/i.test(sql)) {
        const [id, user] = params as string[];
        if (db.rows.get(id)?.user_id === user) db.rows.delete(id);
        return { rows: [] };
      }
      return { rows: [] };
    }
  }
  return { Pool, default: { Pool } };
});

import { createSession } from "@/lib/redteam/session";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "@/lib/redteam/sample";
import { __resetSessions, deleteSession, getSession, saveSession } from "@/lib/redteam/store";

const mk = (user: string) => createSession({ userId: user, mode: "SKEPTIC", title: SAMPLE_TITLE, text: SAMPLE_TEXT, sample: true });

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake/fake";
  db.rows.clear();
  db.log.length = 0;
  db.fail = false;
  __resetSessions();
});

describe("redteam sessions in Postgres", () => {
  it("creates its table on first use, once", async () => {
    await saveSession(mk("a"));
    await saveSession(mk("a"));
    expect(db.log.filter((l) => /^CREATE TABLE/i.test(l.sql))).toHaveLength(1);
  });

  it("round-trips a session and keeps it out of the process's own memory", async () => {
    const s = mk("alice");
    await saveSession(s);
    __resetSessions();
    const back = await getSession("alice", s.id);
    expect(back?.document.passages.length).toBe(s.document.passages.length);
    expect(db.log.some((l) => /^SELECT data/i.test(l.sql))).toBe(true);
  });

  it("scopes every statement that touches a session by user_id", async () => {
    const s = mk("alice");
    await saveSession(s);
    await getSession("alice", s.id);
    await deleteSession("alice", s.id);
    for (const l of db.log.filter((x) => /redteam_sessions/i.test(x.sql) && !/^CREATE TABLE/i.test(x.sql))) {
      expect(l.sql).toMatch(/user_id/i);
      expect(l.params).toContain("alice");
    }
  });

  it("a second user gets nothing for the first user's session id, and cannot overwrite or delete it", async () => {
    const s = mk("alice");
    await saveSession(s);
    expect(await getSession("bob", s.id)).toBeNull();
    const hijack = { ...s, userId: "bob", claims: [] };
    await saveSession(hijack);
    expect((await getSession("alice", s.id))?.userId).toBe("alice");
    expect(await deleteSession("bob", s.id)).toBe(false);
    expect(await getSession("alice", s.id)).not.toBeNull();
  });

  it("an unreachable database degrades to this instance and the review keeps going", async () => {
    const s = mk("alice");
    db.fail = true;
    await saveSession(s); // does not throw
    expect((await getSession("alice", s.id))?.id).toBe(s.id);
    expect(await getSession("bob", s.id)).toBeNull();
  });

  it("a database error message never reaches the caller", async () => {
    db.fail = true;
    await expect(saveSession(mk("alice"))).resolves.toBeUndefined();
  });

  it("refuses a malformed id before it reaches SQL", async () => {
    await getSession("alice", "1'; DROP TABLE redteam_sessions; --");
    expect(db.log).toHaveLength(0);
  });
});
