import { Pool } from "pg";
import { serverLog } from "@/lib/observe";

/**
 * Managed Postgres pool. Lazy singleton; created ONLY when DATABASE_URL is set.
 * - Bounded pool (max 10), statement + connect timeouts (§22).
 * - Verified TLS in production. No raw secrets in logs, and none in the
 *   readiness payload either — see `describeFailure`.
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
      /*
       * Encrypted AND authenticated. This used to read
       * `rejectUnauthorized: false`, which turns TLS into a wire-format
       * choice rather than a guarantee: anyone able to sit on the
       * path to the database could present their own certificate and read or
       * rewrite every learner's rows in the clear. Neon's chain terminates at
       * a public CA, so the system trust store validates it with no extra
       * configuration; a private CA would set PGSSLROOTCERT rather than turn
       * verification back off.
       */
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
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
 * What went wrong, in a closed vocabulary.
 *
 * /api/health/ready is unauthenticated and unrate-limited, and it used to
 * serialise the raw driver message: pg puts the hostname in "getaddrinfo
 * ENOTFOUND ep-….aws.neon.tech" and the role in "password authentication
 * failed for user …". That hands an attacker the database host and username
 * for free, at the exact moment the system is already unhealthy. The full
 * string still goes to serverLog, where the operator can read it.
 */
export function describeFailure(message: string): "auth_failed" | "schema_missing" | "unreachable" {
  if (/authentication|pg_hba|role .* does not exist|password/i.test(message)) return "auth_failed";
  if (/does not exist|undefined_table|undefined_column|42P01|42703/i.test(message)) return "schema_missing";
  return "unreachable";
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
      const raw = (e as Error).message ?? "";
      serverLog("db.probe_failed", "-", { message: raw.slice(0, 200) });
      return { ok: false, durable: false, backend: "postgres", detail: describeFailure(raw) };
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
