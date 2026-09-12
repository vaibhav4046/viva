/**
 * Lightweight analytics: in-memory counters + console-safe log.
 * No PII, no raw transcripts in logs — only event names and latencies.
 */
export type AnalyticsEvent =
  | "dictation_started" | "dictation_completed" | "dictation_failed"
  | "thought_mark_created" | "tutor_response_completed"
  | "exam_started" | "exam_answered" | "teachback_completed"
  | "source_uploaded" | "demo_started" | "demo_completed";

const counts = new Map<string, number>();
const latencies: number[] = [];

export function logEvent(name: AnalyticsEvent, fields: Record<string, number | string | boolean> = {}) {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  if (typeof fields.latencyMs === "number") latencies.push(fields.latencyMs);
}

export function analyticsSnapshot() {
  return {
    counts: Object.fromEntries(counts),
    samples: latencies.length,
    meanLatencyMs:
      latencies.length === 0 ? null : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  };
}
