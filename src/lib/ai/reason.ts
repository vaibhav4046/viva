import type { ZodType } from "zod";
import { HeuristicProvider, ProviderError, recordProviderLatency, recordProviderOutcome, resolveReasoningProvider } from "./provider";

/** Master prompt 5.6. One budget per surface, so a slow model never stalls a turn. */
export const REASON_TIMEOUT_MS = { tutor: 8_000, assessment: 10_000, intake: 45_000 } as const;

export type ReasonResult<T> = { value: T; latencyMs: number };

/**
 * Ask the model for a schema-shaped object, or return null.
 *
 * null means "answer this from the heuristic path": no provider configured, a
 * timeout, a transport error, or output that failed the schema twice (the
 * provider itself does the single repair retry). Callers never see an
 * exception, so a provider outage can never reach the learner as an error.
 */
export async function reasonObject<T>(input: {
  system: string;
  user: string;
  schema: ZodType<T>;
  timeoutMs: number;
}): Promise<ReasonResult<T> | null> {
  let provider;
  try {
    provider = resolveReasoningProvider();
  } catch {
    return null;
  }
  if (provider instanceof HeuristicProvider) return null;

  const started = Date.now();
  try {
    const value = await provider.generateObject({
      system: input.system,
      user: input.user,
      schema: input.schema,
      timeoutMs: input.timeoutMs,
    });
    const latencyMs = Date.now() - started;
    recordProviderLatency(latencyMs);
    recordProviderOutcome("ok");
    return { value, latencyMs };
  } catch (error) {
    recordProviderLatency(Date.now() - started);
    // The class, not the message: readiness reports this, and an upstream
    // message can carry a body. The message still goes to the server log.
    recordProviderOutcome(error instanceof ProviderError ? error.code : "PROVIDER_ERROR");
    console.error("[reason] falling back to the heuristic path:", error instanceof Error ? error.message : error);
    return null;
  }
}
