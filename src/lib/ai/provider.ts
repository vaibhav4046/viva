import { ZodError, type ZodType } from "zod";

/**
 * Reasoning-provider seam for future enrichment (phrasing only).
 * Enrichment seam only: nothing on the mastery/evidence hot path may call
 * this. Evidence selection, scoring, and mastery stay heuristic + deterministic.
 */
export interface ReasoningProvider {
  name: string;
  generateText(input: { system: string; user: string; timeoutMs?: number }): Promise<string>;
  generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback?: T; timeoutMs?: number }): Promise<T>;
}

/**
 * Why a model call did not produce an answer.
 *
 * Split finer than it used to be because the classes want different fixes and
 * looked identical from outside: a rate limit means slow down, a schema
 * mismatch means the prompt does not describe the shape (it did not — three
 * tutor turns in a row silently used the heuristic because the model was
 * answering with keys nobody had asked it for), and a timeout means the budget
 * is short. Readiness reports the class, never the message, so the difference
 * is visible from outside without leaking a key or a stack.
 */
export type ProviderFailure = "TRANSPORT_TIMEOUT" | "RATE_LIMITED" | "SCHEMA_MISMATCH" | "PROVIDER_ERROR" | "CONFIG_MISSING";

export class ProviderError extends Error {
  readonly code: ProviderFailure;
  readonly retryable: boolean;
  constructor(code: ProviderFailure, message: string, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Deterministic fallback: extractive summary, schema-validated fallback object. */
export class HeuristicProvider implements ReasoningProvider {
  readonly name = "heuristic";

  async generateText(input: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    void input.system;
    void input.timeoutMs;
    const prefix = "Key points: ";
    const sentences = input.user.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const summary = sentences.slice(0, 2).join(" ").slice(0, 400 - prefix.length);
    return `${prefix}${summary}`;
  }

  async generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback?: T; timeoutMs?: number }): Promise<T> {
    void input.system;
    void input.user;
    void input.timeoutMs;
    if (input.fallback === undefined) {
      throw new ProviderError("CONFIG_MISSING", "No reasoning provider is configured.", false);
    }
    return input.schema.parse(input.fallback);
  }
}

type ChatMessage = { role: "system" | "user"; content: string };

async function postChat(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new ProviderError("TRANSPORT_TIMEOUT", "Reasoning provider timed out.", true);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout/i.test(msg)) {
      throw new ProviderError("TRANSPORT_TIMEOUT", "Reasoning provider timed out.", true);
    }
    throw new ProviderError("PROVIDER_ERROR", "Reasoning provider unreachable.", true);
  }
  if (!res.ok) {
    if (res.status === 429) throw new ProviderError("RATE_LIMITED", "Reasoning provider returned 429.", true);
    throw new ProviderError("PROVIDER_ERROR", `Reasoning provider returned ${res.status}.`, res.status >= 500);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

/** OpenAI-compatible chat provider (temperature 0.2, 20s default timeout). */
export class OpenAICompatibleProvider implements ReasoningProvider {
  readonly name = "openai-compatible";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  /** For the failover log and readiness: which model this entry speaks to. */
  get modelName(): string {
    return this.model;
  }

  async generateText(input: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    return postChat(this.baseUrl, this.apiKey, {
      model: this.model,
      messages,
      temperature: 0.2,
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback?: T; timeoutMs?: number }): Promise<T> {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const base: ChatMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    // gpt-oss spends its completion budget on reasoning and then wraps the JSON
    // up early. Measured on the same prompt and the same source text: without
    // this the reply stopped after examQuestions and lost the rest of the
    // subject map; with it, the whole object came back in 7.0 s.
    const tuning = /gpt-oss/.test(this.model) ? { reasoning_effort: "low" } : {};
    const first = await postChat(this.baseUrl, this.apiKey, {
      model: this.model,
      messages: base,
      temperature: 0.2,
      response_format: { type: "json_object" },
      ...tuning,
    }, timeout);
    const parsed = tryParseSchema(first, input.schema);
    if (parsed.ok) return parsed.value;
    // ONE repair retry, and it names the fault. "Reply with valid JSON" cannot
    // fix a reply that already WAS valid JSON and merely stopped three keys
    // early, which is what two of six measured failures actually were.
    const repair = await postChat(this.baseUrl, this.apiKey, {
      model: this.model,
      messages: [
        ...base,
        {
          role: "user" as const,
          content: REPAIR_ASK(parsed.why),
        },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
      ...tuning,
    }, timeout);
    const second = tryParseSchema(repair, input.schema);
    if (second.ok) return second.value;
    // Repair failed. With no caller fallback the honest move is to fail so the
    // caller can answer from the heuristic path instead of shipping junk.
    if (input.fallback === undefined) {
      throw new ProviderError("SCHEMA_MISMATCH", "Reasoning provider returned output that did not match the schema.", false);
    }
    return input.schema.parse(input.fallback);
  }
}

/** What to send back when a reply parsed but did not fit. */
const REPAIR_ASK = (why: string) =>
  "Repair: that reply did not match the schema (" +
  why +
  "). Send the corrected JSON object only, every required key present, no prose.";

function tryParseSchema<T>(raw: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; why: string } {
  try {
    return { ok: true, value: schema.parse(JSON.parse(raw)) };
  } catch (e) {
    const why =
      e instanceof ZodError
        ? e.issues.slice(0, 8).map((i) => (i.path.join(".") || "(root)") + ": " + i.message).join("; ")
        : "the reply was not JSON";
    return { ok: false, why };
  }
}

/**
 * Several credentials, tried in order, so one exhausted budget is not an outage.
 *
 * This exists because it happened: the primary key hit its daily token cap
 * mid-session and every turn silently answered from the heuristic path for
 * hours. One provider is a single point of failure for the only part of the
 * product a learner can hear.
 *
 * A entry that fails with a retryable class is skipped for COOLDOWN_MS rather
 * than retried on every turn — a rate limit does not clear in two seconds, and
 * paying a full round trip to rediscover that on each turn is the latency the
 * failover is supposed to hide. A non-retryable failure (bad key, schema
 * mismatch after repair) still falls through to the next entry, because a
 * different model may well parse what this one could not.
 */
const COOLDOWN_MS = 60_000;

/**
 * No attempt gets less than this, however many credentials are left. A budget
 * sliced too thin times out on every entry and reaches none of them.
 */
const MIN_ATTEMPT_MS = 1_500;

export class FailoverProvider implements ReasoningProvider {
  readonly name: string;
  private readonly cooldownUntil = new Map<number, number>();

  constructor(private readonly chain: OpenAICompatibleProvider[]) {
    this.name = chain[0]?.modelName ?? "openai-compatible";
  }

  private available(): { provider: OpenAICompatibleProvider; index: number }[] {
    const now = Date.now();
    const live = this.chain
      .map((provider, index) => ({ provider, index }))
      .filter(({ index }) => (this.cooldownUntil.get(index) ?? 0) <= now);
    // Every entry cooling down at once means the next turn would answer from
    // the heuristic even though a key may have recovered. Try them all rather
    // than guarantee a downgrade.
    return live.length > 0 ? live : this.chain.map((provider, index) => ({ provider, index }));
  }

  /**
   * The caller's timeout is the budget for the whole chain, not for each link.
   *
   * Handing every credential the full `timeoutMs` meant a four-deep chain could
   * spend four times the budget: measured at 61.7 s against a 45 s intake
   * budget, and on an 8 s tutor turn that would be half a minute of silence
   * before the heuristic answers. Each attempt now takes an equal share of what
   * is left, so a credential that fails fast (a 429 costs about 200 ms) hands
   * its unused time to the next one and a slow one cannot eat everyone else's.
   */
  private async run<T>(timeoutMs: number, call: (p: OpenAICompatibleProvider, ms: number) => Promise<T>): Promise<T> {
    let last: unknown = new ProviderError("CONFIG_MISSING", "No reasoning provider is configured.", false);
    const deadline = Date.now() + timeoutMs;
    const queue = this.available();
    for (let i = 0; i < queue.length; i++) {
      const { provider, index } = queue[i];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        last = new ProviderError("TRANSPORT_TIMEOUT", "The reasoning budget ran out before a credential answered.", true);
        break;
      }
      const share = Math.min(remaining, Math.max(MIN_ATTEMPT_MS, Math.floor(remaining / (queue.length - i))));
      try {
        const value = await call(provider, share);
        this.cooldownUntil.delete(index);
        return value;
      } catch (error) {
        last = error;
        if (error instanceof ProviderError && error.code === "RATE_LIMITED") {
          this.cooldownUntil.set(index, Date.now() + COOLDOWN_MS);
        }
        console.error(
          `[provider] ${provider.modelName} failed (${error instanceof ProviderError ? error.code : "PROVIDER_ERROR"}), trying the next credential`
        );
      }
    }
    throw last;
  }

  generateText(input: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    return this.run(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, (p, ms) => p.generateText({ ...input, timeoutMs: ms }));
  }

  generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback?: T; timeoutMs?: number }): Promise<T> {
    return this.run(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, (p, ms) => p.generateObject({ ...input, timeoutMs: ms }));
  }
}

/**
 * Extra credentials, as `baseUrl|key|model` entries separated by commas.
 * Tried after LLM_* in the order given. Malformed entries are dropped rather
 * than thrown, because a typo in a spare key must not take down the primary.
 */
export function parseFallbackChain(raw: string | undefined): OpenAICompatibleProvider[] {
  if (!raw) return [];
  const out: OpenAICompatibleProvider[] = [];
  for (const entry of raw.split(",")) {
    const [baseUrl, apiKey, model] = entry.split("|").map((s) => s.trim());
    if (!baseUrl || !apiKey || !model) continue;
    if (!/^https:\/\//.test(baseUrl)) continue;
    out.push(new OpenAICompatibleProvider(baseUrl, apiKey, model));
  }
  return out;
}

/** Injected provider (tests, and any future in-process model). */
let injected: ReasoningProvider | null = null;
let lastLatencyMs: number | null = null;
/** Cached so the per-credential cooldown survives between turns. */
let failover: FailoverProvider | null = null;

/**
 * The last thing the provider actually did, on this instance.
 *
 * A configured-but-broken provider and an unset one were indistinguishable
 * from outside: readiness said `configured: true, lastLatencyMs: null` in both
 * cases while every turn quietly answered from the heuristic. The fallback
 * staying invisible to the learner is the design; staying invisible to the
 * people running it is how a dead model path survives to a deadline.
 */
type ProviderHealth = {
  lastOutcome: "ok" | ProviderFailure | null;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  failuresSinceOk: number;
};
const health: ProviderHealth = { lastOutcome: null, lastOkAt: null, lastFailureAt: null, failuresSinceOk: 0 };

/** Test seam: pass a stub provider, pass null to restore env resolution. */
export function setReasoningProvider(provider: ReasoningProvider | null): void {
  injected = provider;
  failover = null;
  lastLatencyMs = null;
  health.lastOutcome = null;
  health.lastOkAt = null;
  health.lastFailureAt = null;
  health.failuresSinceOk = 0;
}

/** Called by the reasoning helper after every provider round trip. */
export function recordProviderLatency(ms: number): void {
  lastLatencyMs = ms;
}

/** Called by the reasoning helper with what that round trip amounted to. */
export function recordProviderOutcome(outcome: "ok" | ProviderFailure): void {
  const now = new Date().toISOString();
  health.lastOutcome = outcome;
  if (outcome === "ok") {
    health.lastOkAt = now;
    health.failuresSinceOk = 0;
    return;
  }
  health.lastFailureAt = now;
  health.failuresSinceOk += 1;
}

/**
 * What /api/health/ready reports. `configured` answers "would a turn use the
 * model right now", so a partially-filled env reads as not configured rather
 * than as a promise the product cannot keep.
 */
export function providerStatus(): {
  configured: boolean;
  model: string | null;
  lastLatencyMs: number | null;
  /** "ok", a failure class, or null when nothing has called it on this instance. */
  lastOutcome: "ok" | ProviderFailure | null;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  failuresSinceOk: number;
  /** Configured, and not known to be failing. */
  usable: boolean;
  /** How many credentials a turn can fall through. */
  credentials: number;
} {
  const envConfigured = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
  const credentials = (envConfigured ? 1 : 0) + parseFallbackChain(process.env.LLM_FALLBACKS).length;
  const configured = Boolean(injected) || envConfigured || credentials > 0;
  return {
    configured,
    credentials,
    model: injected ? injected.name : envConfigured ? (process.env.LLM_MODEL ?? null) : null,
    lastLatencyMs,
    ...health,
    // Not yet asked is not the same as broken, so a cold instance that nobody
    // has put a turn through is not accused of being down.
    usable: configured && (health.lastOutcome === null || health.lastOutcome === "ok"),
  };
}

/**
 * The provider a turn will actually use.
 *
 * Three filled-in LLM_* vars are enough — a deployment that has credentials
 * should not answer from the heuristic path because AI_PROVIDER was forgotten.
 * Setting AI_PROVIDER explicitly makes an incomplete set an error instead of a
 * silent downgrade.
 */
export function resolveReasoningProvider(): ReasoningProvider {
  if (injected) return injected;
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (process.env.AI_PROVIDER === "openai-compatible" && !(baseUrl && apiKey && model)) {
    throw new ProviderError("CONFIG_MISSING", "AI_PROVIDER=openai-compatible needs LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.", false);
  }
  const chain = [
    ...(baseUrl && apiKey && model ? [new OpenAICompatibleProvider(baseUrl, apiKey, model)] : []),
    ...parseFallbackChain(process.env.LLM_FALLBACKS),
  ];
  if (chain.length === 1) return chain[0];
  if (chain.length > 1) return failover ?? (failover = new FailoverProvider(chain));
  return new HeuristicProvider();
}
