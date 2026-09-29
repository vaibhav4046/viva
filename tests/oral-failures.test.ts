import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLimits } from "@/lib/limits";
import { ORAL_FAILURES, failureFor, machineFor, oralMessage } from "@/lib/oral/failures";
import { ORAL_STATES, initialMachine, onConnecting, onEnded, onError, onRecovering, onReplyAudio, onReplyDone, onSessionReady, onSpeechStarted, onStartStreaming, onUserFinal, onCheckingSource, onToolCall } from "@/lib/oral/machine";
import { voiceMessage } from "@/lib/audio/messages";

/**
 * Every failure the spec lists, mapped to a machine state, an error code and a
 * message. The table is one file (src/lib/oral/failures.ts); these tests drive
 * the real causes where a cause can run headlessly:
 *  - token 401/403/422/429/5xx/timeout and missing key: the real route with a stubbed upstream
 *  - socket close, refused resume, tool timeout, unexpected end, hidden tab, long silence: tests/oral-socket.test.ts
 *  - microphone denied, no device, insecure context, no worklet: the client checks in mic.ts, covered by the table
 *    and the manual checklist in docs/notes/core.md (a browser is needed to raise them for real).
 */

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "viva_did" && jar.value !== undefined ? { name, value: jar.value } : undefined) }),
}));
const { GET } = await import("@/app/api/voice-agent/token/route");

const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const UPSTREAM_SECRET_BODY = "account acct_9f3 rejected key sk_live_should_never_leak";

beforeEach(() => {
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  jar.value = undefined;
  __resetLimits();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
  __resetLimits();
});

const get = (ip = "203.0.113.7") => GET(new Request("http://localhost/api/voice-agent/token", { headers: { "x-forwarded-for": ip } }));
const upstream = (status: number) => { globalThis.fetch = (async () => new Response(UPSTREAM_SECRET_BODY, { status })) as typeof fetch; };

describe("the failure table", () => {
  it("covers every failure the spec lists", () => {
    const ids = ORAL_FAILURES.map((f) => f.id);
    for (const id of ["mic_denied", "no_audio_device", "insecure_context", "no_audio_worklet", "token_unauthorized", "token_bad_request", "token_rate_limited", "token_upstream_down", "socket_error", "socket_closed", "tool_timeout", "session_ended_early", "tab_hidden", "long_silence", "no_api_key"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("gives each failure a real state, a unique code and a sentence with a next action, never a blank", () => {
    const codes = new Set<string>();
    for (const f of ORAL_FAILURES) {
      expect(ORAL_STATES, f.id).toContain(f.state);
      expect(codes.has(f.code), `duplicate code ${f.code}`).toBe(false);
      codes.add(f.code);
      expect(f.message.length, f.id).toBeGreaterThan(20);
      // a next action: an imperative or an offer
      expect(f.message, f.id).toMatch(/start again|reload|try |come back|say something|reconnect|allow|open |plug|carries on|carrying on|go on|end the exam|start a new/i);
      // no status codes or vendor internals in what the learner reads
      expect(f.message, f.id).not.toMatch(/\b(401|403|422|429|500|502|503)\b|websocket|http|token|json|stack/i);
      expect(f.message).not.toContain(String.fromCharCode(0x2014));
      expect(oralMessage(f.code)).toBe(f.message);
    }
    expect(oralMessage("SOMETHING_UNKNOWN")).toMatch(/start again/i);
    expect(oralMessage(undefined).length).toBeGreaterThan(10);
  });

  it("puts a failure raised before any socket into ERROR with the code and the right fatality", () => {
    for (const f of ORAL_FAILURES.filter((x) => x.state === "ERROR")) {
      const m = machineFor(f);
      expect(m.state, f.id).toBe("ERROR");
      expect(m.reason).toBe(f.code);
      expect(m.fatal).toBe(f.fatal);
    }
    expect(() => machineFor(failureFor("SOCKET_CLOSED")!)).toThrow();
  });

  it("reaches all twelve machine states through real transitions", () => {
    const seen = new Set<string>();
    const see = <T extends { state: string }>(m: T): T => { seen.add(m.state); return m; };
    let m = see(initialMachine());
    m = see(onConnecting(m));
    m = see(onSessionReady(m, { session_id: "s" }));
    m = see(onStartStreaming(m));
    m = see(onSpeechStarted(m));
    m = see(onUserFinal(m, { item_id: "i", text: "x" }));
    m = see(onToolCall(m, { call_id: "c", name: "verify_claim", arguments: {} }));
    m = see(onCheckingSource(m));
    m = see(onReplyAudio(m));
    m = see(onReplyDone(m, { status: "interrupted" }).machine);
    m = see(onRecovering(m, "drop"));
    m = see(onError(m, "x", false));
    m = see(onRecovering(m, "again"));
    m = see(onEnded(m));
    expect([...seen].sort()).toEqual([...ORAL_STATES].sort());
  });
});

describe("token route: every status maps to a code and never leaks the upstream body", () => {
  const cases: [string, number, number, string, boolean][] = [
    ["upstream 401", 401, 502, "AUTH_FAILED", false],
    ["upstream 403", 403, 502, "AUTH_FAILED", false],
    ["upstream 422", 422, 502, "BAD_RESPONSE", false],
    ["upstream 429", 429, 429, "RATE_LIMITED", true],
    ["upstream 500", 500, 502, "TRANSCRIPTION_FAILED", true],
    ["upstream 503", 503, 502, "TRANSCRIPTION_FAILED", true],
  ];
  for (const [name, up, status, code, retryable] of cases) {
    it(`${name} -> ${status} ${code}`, async () => {
      upstream(up);
      const res = await get();
      const text = await res.text();
      expect(res.status).toBe(status);
      const body = JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } };
      expect(body.error.code).toBe(code);
      expect(body.error.retryable).toBe(retryable);
      expect(text).not.toContain("acct_9f3");
      expect(text).not.toContain("sk_live");
      expect(body.error.message).toBe(voiceMessage(code));
      expect(failureFor(code), code).toBeDefined();
    });
  }

  it("a network failure is TRANSCRIPTION_FAILED and a timeout is PROVIDER_TIMEOUT", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(((await (await get()).json()) as { error: { code: string } }).error.code).toBe("TRANSCRIPTION_FAILED");
    globalThis.fetch = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as typeof fetch;
    const res = await get("203.0.113.8");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_TIMEOUT");
  });

  it("a missing key is NO_API_KEY, 503, not retryable, and the upstream is never called", async () => {
    delete process.env.ASSEMBLYAI_API_KEY;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await get();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: "NO_API_KEY", retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a 200 without a token is BAD_RESPONSE, not a token", async () => {
    globalThis.fetch = (async () => Response.json({ expires_in_seconds: 600 })) as typeof fetch;
    const res = await get();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_RESPONSE");
  });

  it("rate limits at 429 with the ceiling of the transcribe class, per address", async () => {
    globalThis.fetch = (async () => Response.json({ token: "tok", expires_in_seconds: 600 })) as typeof fetch;
    let limited = 0;
    for (let i = 0; i < 14; i++) if ((await get("198.51.100.9")).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(1);
    expect((await get("198.51.100.10")).status).toBe(200);
  });

  it("sends the key raw, never to the browser, and asks for the capped expiry", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
      return Response.json({ token: "tok_short", expires_in_seconds: 600 });
    }) as typeof fetch;
    const res = await get();
    const text = await res.text();
    expect(seen!.url).toContain("expires_in_seconds=600");
    expect(seen!.auth).toBe("test-key");
    expect(text).not.toContain("test-key");
    expect(JSON.parse(text)).toEqual({ token: "tok_short", expiresInSeconds: 600 });
  });
});
