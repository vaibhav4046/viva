/**
 * Per-identity/IP token-bucket rate limiting for expensive endpoints.
 * One AssemblyAI balance must not be burnable by one client.
 * NOTE: instance-local Map — correct on a single instance; the documented
 * upgrade is a shared store (Redis/Upstash) when scaling horizontally.
 */

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();
// Bound the map: single-process memory must not grow with attacker cardinality.
const MAX_BUCKETS = 10_000;

function pruneBuckets() {
  if (buckets.size <= MAX_BUCKETS) return;
  const keys = [...buckets.keys()].slice(0, buckets.size - MAX_BUCKETS);
  for (const k of keys) buckets.delete(k);
}

export type LimitClass = "transcribe" | "compile" | "exam" | "upload" | "default";

const CLASS_BUDGET: Record<LimitClass, { capacity: number; refillPerSec: number }> = {
  transcribe: { capacity: 12, refillPerSec: 12 / 60 }, // 12 dictations/min
  compile: { capacity: 60, refillPerSec: 1 }, // 60/min
  exam: { capacity: 30, refillPerSec: 0.5 }, // 30/min
  upload: { capacity: 10, refillPerSec: 10 / 60 }, // 10 PDF uploads/min
  default: { capacity: 120, refillPerSec: 2 },
};

export function checkLimit(key: string, cls: LimitClass = "default"): { ok: true } | { ok: false; retryAfterSec: number } {
  const budget = CLASS_BUDGET[cls];
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: budget.capacity, updatedAt: now };
  const elapsed = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(budget.capacity, b.tokens + elapsed * budget.refillPerSec);
  b.updatedAt = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    pruneBuckets();
    return { ok: true };
  }
  buckets.set(key, b);
  const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / budget.refillPerSec));
  return { ok: false, retryAfterSec };
}

export function limitKey(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(":");
}

/** For tests: reset all buckets. */
export function __resetLimits() {
  buckets.clear();
}
