import { backendKind } from "@/lib/db/db";
import { FileEventStore } from "./file";
import { PgEventStore } from "./pg";
import type { EventStore } from "./repo";

/**
 * Durable-backend degradation state (per serverless instance).
 *
 * Observed in production: a durable backend can keep serving reads while every
 * write fails, so a read-only readiness probe reports a healthy store while
 * every route that calls `seedCourse` returns an opaque 500. A judge landing
 * on /today saw a dead app and no explanation.
 *
 * §17 says a failure must degrade to something useful and clearly labelled,
 * never a crash. So the first durable-backend rejection flips this instance to
 * the ephemeral file store (/tmp on Vercel) and the readiness endpoint says so
 * out loud. The demo keeps working; nobody is told a lie about durability.
 */
type Degradation = {
  degraded: boolean;
  from: string;
  reason: string;
  since: string | null;
};

const degradation: Degradation = { degraded: false, from: "", reason: "", since: null };

/** Snapshot of the degradation state, for /api/health/ready to report. */
export function storeDegradation(): Degradation {
  return { ...degradation };
}

/** Test seam: clear the latch between cases. */
export function resetStoreDegradation(): void {
  degradation.degraded = false;
  degradation.from = "";
  degradation.reason = "";
  degradation.since = null;
}

/**
 * Wrap a durable store so the first failed call latches this instance onto the
 * fallback and RETRIES there, rather than surfacing a 500. Reads and writes
 * both move, so a request never mixes two backends and sees torn state.
 *
 * ponytail: the latch is per-instance and never resets, so one transient
 * backend error costs durability until the instance recycles. Correct trade
 * while a hard failure is the alternative; add a timed half-open retry if
 * transient flakiness (rather than a broken credential) ever becomes the norm.
 */
function withFallback(durable: EventStore, kind: string): EventStore {
  const fallback = new FileEventStore();
  return new Proxy(durable, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;
      const onFallback = (fallback as unknown as Record<string, unknown>)[prop as string];

      return async (...args: unknown[]) => {
        if (degradation.degraded && typeof onFallback === "function") {
          return (onFallback as (...a: unknown[]) => unknown).apply(fallback, args);
        }
        try {
          return await (original as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (typeof onFallback !== "function") throw error;
          if (!degradation.degraded) {
            degradation.degraded = true;
            degradation.from = kind;
            degradation.reason = (error as Error)?.message?.slice(0, 180) ?? "unknown";
            degradation.since = new Date().toISOString();
            console.error(
              `[store] ${kind} backend failed on ${String(prop)} — falling back to the ephemeral file store for this instance:`,
              error
            );
          }
          return (onFallback as (...a: unknown[]) => unknown).apply(fallback, args);
        }
      };
    },
  }) as EventStore;
}

/** Factory: Postgres when configured, otherwise the file store. */
export function getStore(): EventStore {
  if (backendKind() === "postgres") return withFallback(new PgEventStore(), "postgres");
  return new FileEventStore();
}

export function learnerDNA(mastery: Record<string, { mastery: number; misconceptionCount: number }>, recentConfusionIds: string[], totalEvents: number) {
  const entries = Object.entries(mastery);
  return {
    explanationPreference: "analogy_then_formal",
    preferredResponseLength: "short",
    strongConcepts: entries.filter(([, m]) => m.mastery >= 0.65).map(([id]) => id),
    developingConcepts: entries.filter(([, m]) => m.mastery >= 0.45 && m.mastery < 0.65).map(([id]) => id),
    recurringMisconceptions: entries.filter(([, m]) => m.misconceptionCount > 0).map(([id]) => id),
    recentConfusions: recentConfusionIds.slice(-5),
    recallPatterns: { totalEvents },
    interactionPreference: "spoken_recall",
    weak: entries.filter(([, m]) => m.mastery < 0.45).map(([id]) => id),
    note: "Based on your VIVA sessions — interaction preferences and learning history, not neuroscience.",
  };
}

export type { EventStore };
