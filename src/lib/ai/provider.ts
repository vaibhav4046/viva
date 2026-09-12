import type { ZodType } from "zod";

/**
 * Reasoning-provider seam for future enrichment (phrasing only).
 * Enrichment seam only: nothing on the mastery/evidence hot path may call
 * this. Evidence selection, scoring, and mastery stay heuristic + deterministic.
 */
export interface ReasoningProvider {
  name: string;
  generateText(input: { system: string; user: string; timeoutMs?: number }): Promise<string>;
  generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback: T; timeoutMs?: number }): Promise<T>;
}

export class ProviderError extends Error {
  readonly code: "TRANSPORT_TIMEOUT" | "PROVIDER_ERROR" | "CONFIG_MISSING";
  readonly retryable: boolean;
  constructor(code: ProviderError["code"], message: string, retryable = false) {
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

  async generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback: T; timeoutMs?: number }): Promise<T> {
    void input.system;
    void input.user;
    void input.timeoutMs;
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
    throw new ProviderError("PROVIDER_ERROR", `Reasoning provider returned ${res.status}.`, res.status >= 500 || res.status === 429);
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

  async generateObject<T>(input: { system: string; user: string; schema: ZodType<T>; fallback: T; timeoutMs?: number }): Promise<T> {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const base: ChatMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    const first = await postChat(this.baseUrl, this.apiKey, {
      model: this.model,
      messages: base,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }, timeout);
    const parsed = tryParseSchema(first, input.schema);
    if (parsed.ok) return parsed.value;
    // ONE repair retry: ask for valid JSON only, then fall back (never throw raw output).
    const repair = await postChat(this.baseUrl, this.apiKey, {
      model: this.model,
      messages: [
        ...base,
        { role: "user" as const, content: "Repair: reply with ONLY valid JSON matching the expected schema, no prose." },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }, timeout);
    const second = tryParseSchema(repair, input.schema);
    if (second.ok) return second.value;
    return input.schema.parse(input.fallback);
  }
}

function tryParseSchema<T>(raw: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: schema.parse(JSON.parse(raw)) };
  } catch {
    return { ok: false };
  }
}

/** "openai-compatible" when AI_PROVIDER says so (requires LLM_* env), else heuristic default. */
export function resolveReasoningProvider(): ReasoningProvider {
  if (process.env.AI_PROVIDER === "openai-compatible") {
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new ProviderError("CONFIG_MISSING", "AI_PROVIDER=openai-compatible needs LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.", false);
    }
    return new OpenAICompatibleProvider(baseUrl, apiKey, model);
  }
  return new HeuristicProvider();
}
