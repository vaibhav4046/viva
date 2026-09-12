/**
 * Structured observability: request IDs, stage timings, safe JSON logs.
 * NEVER logs: API keys, raw audio, transcripts, cookies.
 */

export function rid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class Trace {
  private stages = new Map<string, number>();
  private marks = new Map<string, number>();
  constructor(readonly id: string = rid()) {}

  start(stage: string) {
    this.marks.set(stage, Date.now());
  }

  end(stage: string) {
    const t0 = this.marks.get(stage);
    if (t0 !== undefined) this.stages.set(stage, Date.now() - t0);
  }

  timings(): Record<string, number> {
    return Object.fromEntries(this.stages);
  }

  totalMs(): number {
    return [...this.stages.values()].reduce((a, b) => a + b, 0);
  }
}

type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Server-side JSON log line. Safe by construction: callers pass metrics only. */
export function serverLog(event: string, traceId: string, fields: LogFields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, traceId, ...fields });
  if (process.env.NODE_ENV === "test") return;
  console.log(line);
}
