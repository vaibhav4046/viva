/**
 * How an MCP tool reaches VIVA: over VIVA's own HTTP routes, carrying the
 * cookie the paired token resolved to.
 *
 * Nothing here re-implements a capability. `/api/study/turn` decides intent,
 * retrieval, grounding and every mastery number; `/api/exam/*` marks answers;
 * `/api/subjects/create` builds a subject. A second copy of any of that would
 * drift from the screens within a week, and the first thing to drift would be
 * the part that decides whose rows are read.
 *
 * So the tool layer is a client. The one thing it adds is the cookie, and the
 * cookie is rebuilt from a signed token — never from anything the caller said.
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type ApiContext = {
  /** Where this deployment answers its own requests. */
  origin: string;
  /** `viva_did=…`, rebuilt from the verified token. */
  cookie: string;
  /** Passed through so per-caller rate limits stay per-caller. */
  forwardedFor: string | null;
  fetch: Fetcher;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string };

/**
 * A tool that could not do what was asked.
 *
 * Thrown rather than returned so a refusal cannot be mistaken for an answer:
 * MCP marks a failed call `isError`, and an assistant that cannot tell "this
 * subject is not yours" from "here is your subject" will read the refusal out
 * as if it were the material.
 */
export class ToolFailure extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

/** VIVA's routes already answer with one plain sentence. Use theirs, not ours. */
const UNREACHABLE = "VIVA did not answer that just now. Try again in a moment.";

function headersFor(ctx: ApiContext, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Cookie: ctx.cookie, ...extra };
  if (ctx.forwardedFor) headers["x-forwarded-for"] = ctx.forwardedFor;
  return headers;
}

function errorFrom(body: unknown, status: number): { message: string; code: string } {
  const shaped = body as { error?: { message?: unknown; code?: unknown } } | null;
  const message = typeof shaped?.error?.message === "string" ? shaped.error.message : UNREACHABLE;
  const code = typeof shaped?.error?.code === "string" ? shaped.error.code : `HTTP_${status}`;
  return { message, code };
}

/** GET or POST one VIVA route as the paired student, and read JSON back. */
export async function callViva<T>(
  ctx: ApiContext,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await ctx.fetch(`${ctx.origin}${path}`, {
      method,
      headers: headersFor(ctx, init.body === undefined ? undefined : { "Content-Type": "application/json" }),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: UNREACHABLE, code: "UNREACHABLE" };
  }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) return { ok: false, ...errorFrom(parsed, res.status) };
  if (parsed === null) return { ok: false, message: UNREACHABLE, code: "BAD_RESPONSE" };
  return { ok: true, data: parsed as T };
}

/**
 * `/api/subjects/create` streams one sentence per step as newline-delimited
 * JSON and finishes with the built subject. An assistant has nothing to do
 * with a progress line, so this collects the stream and returns the last
 * useful object — the subject, or the refusal that ended it.
 */
export async function callVivaStream<T>(
  ctx: ApiContext,
  path: string,
  body: unknown
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await ctx.fetch(`${ctx.origin}${path}`, {
      method: "POST",
      headers: headersFor(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: UNREACHABLE, code: "UNREACHABLE" };
  }
  const text = await res.text().catch(() => "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let last: unknown = null;
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const shaped = value as { line?: unknown; error?: unknown };
    if (typeof shaped.line === "string") continue;
    if (shaped.error) return { ok: false, ...errorFrom(value, res.status) };
    last = value;
  }
  if (!res.ok) return { ok: false, ...errorFrom(last, res.status) };
  if (last === null) return { ok: false, message: UNREACHABLE, code: "BAD_RESPONSE" };
  return { ok: true, data: last as T };
}
