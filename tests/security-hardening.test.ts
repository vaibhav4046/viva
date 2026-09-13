import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/http";
import type { EventStore } from "@/lib/store/repo";

/**
 * Four small controls that were each one line away from being right.
 *
 * They share a shape: something the app already knew is true was reported, or
 * trusted, in a form that gives it away — an unverified TLS peer, a database
 * host handed to an unauthenticated prober, a rate-limit key the caller picks,
 * and a page that claims a stronger guarantee than the code implements.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the database connection is authenticated, not just encrypted", () => {
  it("verifies the server certificate in production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    // sslmode in the URL is the setting an operator thinks they control; the
    // explicit option is the one node-postgres actually uses, so assert there.
    vi.stubEnv("DATABASE_URL", "postgres://viva_owner:pw@db.example.test/viva?sslmode=require");
    const { getPool } = await import("@/lib/db/db");
    const pool = getPool();
    try {
      expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });
});

describe("the readiness probe says whether, not who and where", () => {
  const HOST = "ep-quiet-brook-12345678.eu-central-1.aws.neon.invalid";
  const USER = "viva_owner";
  const ALLOWED = ["reachable, schema present", "unreachable", "auth_failed", "schema_missing"];

  it("names no database host or role when the database is down", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", `postgres://${USER}:hunter2@${HOST}/vivadb`);
    const { GET } = await import("@/app/api/health/ready/route");
    const body = await (await GET()).json();
    const serialised = JSON.stringify(body);

    expect(body.database.ok).toBe(false);
    for (const secret of [HOST, "neon.invalid", "ep-quiet-brook", USER, "hunter2", "ENOTFOUND", "getaddrinfo"]) {
      expect(serialised, `readiness payload names ${secret}`).not.toContain(secret);
    }
    expect(ALLOWED).toContain(body.database.detail);
  }, 20_000);

  it("names none of it through the degradation latch either", async () => {
    vi.resetModules();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-ready-"));
    vi.stubEnv("DATA_DIR", tmp);
    try {
      // The latch keeps the driver's own words on purpose; the readiness
      // payload is the boundary where they must stop.
      const store = await import("@/lib/store");
      const failing = {
        backend: "postgres" as const,
        async listSubjects() {
          throw new Error(`getaddrinfo ENOTFOUND ${HOST}`);
        },
      };
      await store.withFallback(failing as unknown as EventStore, "postgres").listSubjects("u_probe");
      expect(store.storeDegradation().degraded).toBe(true);

      const { GET } = await import("@/app/api/health/ready/route");
      const body = await (await GET()).json();
      expect(body.store.mode).toBe("ephemeral-fallback");
      expect(JSON.stringify(body)).not.toContain(HOST);
      expect(ALLOWED).toContain(body.store.reason);

      store.resetStoreDegradation();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("the rate-limit key is the hop the platform wrote, not the one the caller sent", () => {
  const ip = (headers: Record<string, string>) => clientIp(new NextRequest("http://localhost/api/study/turn", { headers }));

  it("ignores entries the client prepended to x-forwarded-for", () => {
    // A caller sending "1.2.3.4" gets it echoed into the chain ahead of the
    // address the proxy saw. Keying on it is a fresh bucket per request.
    expect(ip({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })).toBe("203.0.113.9");
    expect(ip({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9" })).toBe("203.0.113.9");
    expect(ip({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
  });

  it("rotating the spoofed entry does not move the bucket", () => {
    const keys = new Set(["a", "b", "c"].map((n) => ip({ "x-forwarded-for": `${n}, 203.0.113.9` })));
    expect(keys).toEqual(new Set(["203.0.113.9"]));
  });

  it("prefers the header the platform sets itself, on the platform that sets it", () => {
    vi.stubEnv("VERCEL", "1");
    expect(ip({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })).toBe("203.0.113.9");
  });

  it("does not trust that header anywhere else, where the caller can write it too", () => {
    // `next start` is a path this repo ships. Nothing sets x-vercel-forwarded-for
    // there, so honouring it would just move the spoof to a new header name.
    vi.stubEnv("VERCEL", "");
    expect(ip({ "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 203.0.113.9" })).toBe("203.0.113.9");
  });

  it("still answers when there is no chain at all", () => {
    expect(ip({})).toBe("unknown");
    expect(ip({ "x-forwarded-for": "" })).toBe("unknown");
  });
});

describe("the Connect page does not promise more than the code does", () => {
  const page = readFileSync(new URL("../src/app/(app)/connect/page.tsx", import.meta.url), "utf8");

  it("drops the single-use claim, because a pairing code is signed and not stored", () => {
    // Nothing in src/lib/mcp records a spent code, so a code seen inside its
    // window can be exchanged again. Saying otherwise is a false claim in the
    // one place a student is deciding how carefully to handle it.
    expect(page).not.toMatch(/works once/i);
    expect(page).not.toMatch(/single[- ]use/i);
  });

  it("says what is actually true: anyone who sees it inside the window can use it", () => {
    expect(page).toMatch(/anyone who (can )?see/i);
  });
});
