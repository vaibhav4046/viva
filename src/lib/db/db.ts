import { Pool } from "pg";
import { serverLog } from "@/lib/observe";

/**
 * Managed Postgres pool. Lazy singleton; created ONLY when DATABASE_URL is set.
 * - Bounded pool (max 10), statement + connect timeouts (§22).
 * - SSL in production. No raw secrets in logs.
 */

let pool: Pool | null = null;

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

export function backendKind(): "postgres" | "file" {
  return isDbConfigured() ? "postgres" : "file";
}

export function getPool(): Pool {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", (e) => serverLog("db.pool_error", "-", { message: (e as Error).message }));
  }
  return pool;
}

export async function dbQuery<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rows as T[];
}

/**
 * `ok` = the app can serve from this backend right now.
 * `durable` = data written here survives a redeploy / a new serverless
 * instance. They are NOT the same thing, and conflating them is how the
 * readiness endpoint once reported a healthy durable store while the file
 * fallback underneath it was ephemeral.
 */
export async function dbStatus(): Promise<{ ok: boolean; durable: boolean; backend: string; detail: string }> {
  if (isDbConfigured()) {
    try {
      const rows = await dbQuery<{ ok: boolean }>("SELECT true AS ok");
      if (!rows.length) throw new Error("empty probe");
      await dbQuery("SELECT 1 FROM learning_events LIMIT 1");
      return { ok: true, durable: true, backend: "postgres", detail: "reachable, schema present" };
    } catch (e) {
      // Configured but unreachable/broken schema → NOT ready (never lie).
      return { ok: false, durable: false, backend: "postgres", detail: `unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  }
  // Serving, but only durable on a real disk. On Vercel this is /tmp, scoped
  // to one instance, so it must not report durability.
  return {
    ok: true,
    durable: !process.env.VERCEL,
    backend: "file",
    detail: process.env.VERCEL
      ? "ephemeral per-instance file store (/tmp) — data does not survive a redeploy"
      : "DATABASE_URL unset — local file store (dev only, ephemeral on serverless)",
  };
}
