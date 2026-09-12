/**
 * Failure protection for the AssemblyAI dependency.
 * Consecutive-failure breaker: after THRESHOLD failures, fail fast for
 * COOLDOWN_MS so we stop hammering a struggling service. Half-open probe
 * lets one request through to detect recovery.
 * NOTE: per-process state — correct on single-instance/serverless-per-invoke
 * scale; a shared (Redis) breaker is the documented upgrade path.
 */

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = "closed";
  constructor(private threshold = 5, private cooldownMs = 60_000) {}

  getState(): BreakerState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /** Returns true when a call may proceed; false when the breaker is open. */
  allow(): boolean {
    return this.getState() !== "open";
  }

  success() {
    this.failures = 0;
    this.state = "closed";
  }

  failure() {
    this.failures += 1;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return { state: this.getState(), consecutiveFailures: this.failures };
  }
}

export const assemblyAIBreaker = new CircuitBreaker(5, 60_000);
