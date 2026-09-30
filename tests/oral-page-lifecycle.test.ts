import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_TIMEOUT_MS } from "@/components/oral/useOralSession";

/**
 * Lifecycle rules of the /oral page, from the independent review of the first
 * screen: a microphone must never outlive its exam, every notice must reach the
 * screen, End and Type instead must abandon a start that is waiting on the
 * browser prompt, and the connect step must time out into a designed message.
 * The hook needs a browser to run, so these read its source, the way
 * tests/oral-security.test.ts reads the socket; scripts/oral-ui-drive.mjs
 * exercises the same paths in Chromium.
 */
const src = readFileSync(join(process.cwd(), "src", "components", "oral", "useOralSession.ts"), "utf8").replace(/\r\n/g, "\n");
const block = (start: string, chars = 600) => {
  const at = src.indexOf(start);
  expect(at, `${start} present`).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
};

describe("microphone lifecycle", () => {
  it("releases the microphone when the service ends the session unasked", () => {
    expect(block("onEnded: (summary)")).toContain("micRef.current?.cancel()");
  });
  it("releases the microphone on a failure", () => {
    expect(block("const fail = (view: FailureView)")).toContain("micRef.current?.cancel()");
  });
  it("cancels any earlier microphone before a new start", () => {
    expect(block("const begin = useCallback", 300)).toContain("micRef.current?.cancel()");
  });
  it("cancels a handle that arrives after the learner chose End or Type instead", () => {
    expect(block("if (attemptRef.current !== attempt) {", 300)).toContain("handle.cancel()");
    expect(block("const openTyped = useCallback", 200)).toContain("attemptRef.current += 1");
    expect(block("const end = useCallback", 300)).toContain("attemptRef.current += 1");
  });
});

describe("notices and timeouts", () => {
  it("passes onNotice so tab hidden, long silence, tool timeout, resumed and ended-early reach the screen", () => {
    expect(src).toContain("onNotice:");
    expect(src).toContain("failureViewFromCode(code)");
  });
  it("times the connect step out into the designed message", () => {
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(block("// Connect watchdog", 700)).toContain('failureViewFor("token_timeout")');
    expect(src).toContain("AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS)");
  });
});

describe("session record", () => {
  it("reads the session id from a ref, not from the first render's machine", () => {
    expect(src).toContain("sessionIdRef.current");
    expect(src).not.toMatch(/sessionId:\s*machine\.sessionId/);
  });
  it("shows no ratio that can pass 100 percent and no resumable claim", () => {
    const parts = readFileSync(join(process.cwd(), "src", "components", "oral", "OralParts.tsx"), "utf8");
    expect(parts + src).not.toMatch(/resumable|Grounding/);
  });
});
