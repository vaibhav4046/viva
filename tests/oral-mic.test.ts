import { afterEach, describe, expect, it, vi } from "vitest";
import { startOralExam } from "@/components/oral/mic";

/**
 * The microphone side, with every browser global faked.
 *
 * The audio graph cannot run in Node, so these tests pin the failure handling
 * around it: a context the browser suspended, and a graph that fails to build
 * after the microphone is already open.
 */

type Track = { stopped: boolean; stop: () => void };

class FakeCtx {
  static last: FakeCtx | null = null;
  state = "suspended";
  resumeCalls = 0;
  closed = false;
  onstatechange: (() => void) | null = null;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  constructor() {
    FakeCtx.last = this;
  }
  resume() {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  createMediaStreamSource() {
    if (FakeCtx.sourceThrows) throw new Error("source refused");
    return { connect() {} };
  }
  static sourceThrows = false;
}

class FakeNode {
  static throws = false;
  port = { onmessage: null as unknown, postMessage() {} };
  constructor() {
    if (FakeNode.throws) throw new Error("worklet node refused");
  }
  connect() {}
  disconnect() {}
}

const noop = () => {};
const baseArgs = () => ({
  config: { system_prompt: "p", greeting: "g", tools: [] },
  subjectId: "s1",
  onState: noop,
  onTurn: noop,
  onError: noop,
  onEnded: noop,
});

function stubBrowser() {
  const tracks: Track[] = [{ stopped: false, stop() { this.stopped = true; } }];
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } });
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  return tracks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeCtx.last = null;
  FakeCtx.sourceThrows = false;
  FakeNode.throws = false;
});

describe("AudioContext state (Q16)", () => {
  it("resumes a context the browser started suspended", async () => {
    stubBrowser();
    const handle = await startOralExam(baseArgs(), { getToken: async () => "t", runTool: async () => ({}), openSocket: () => ({}) as WebSocket });
    expect(FakeCtx.last?.resumeCalls).toBeGreaterThanOrEqual(1);
    handle.cancel();
  });

  it("resumes again when the context is suspended or interrupted mid-exam", async () => {
    stubBrowser();
    const handle = await startOralExam(baseArgs(), { getToken: async () => "t", runTool: async () => ({}), openSocket: () => ({}) as WebSocket });
    const ctx = FakeCtx.last!;
    const before = ctx.resumeCalls;
    ctx.state = "interrupted";
    ctx.onstatechange?.();
    expect(ctx.resumeCalls).toBe(before + 1);
    ctx.state = "running";
    ctx.onstatechange?.();
    expect(ctx.resumeCalls).toBe(before + 1);
    handle.cancel();
  });

  it("stops listening for state changes after teardown", async () => {
    stubBrowser();
    const handle = await startOralExam(baseArgs(), { getToken: async () => "t", runTool: async () => ({}), openSocket: () => ({}) as WebSocket });
    const ctx = FakeCtx.last!;
    handle.cancel();
    expect(ctx.onstatechange).toBeNull();
  });
});

describe("audio graph construction (Q23)", () => {
  it("tears everything down and reports NO_WORKLET when AudioWorkletNode throws", async () => {
    const tracks = stubBrowser();
    FakeNode.throws = true;
    const getToken = vi.fn(async () => "t");
    const openSocket = vi.fn(() => ({}) as WebSocket);
    await expect(startOralExam(baseArgs(), { getToken, runTool: async () => ({}), openSocket })).rejects.toThrow();
    expect(tracks[0].stopped).toBe(true);
    expect(FakeCtx.last?.closed).toBe(true);
    // No socket and no token: a failed graph must not leave a billed session behind.
    expect(getToken).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("does the same when createMediaStreamSource throws", async () => {
    const tracks = stubBrowser();
    FakeCtx.sourceThrows = true;
    const getToken = vi.fn(async () => "t");
    await expect(startOralExam(baseArgs(), { getToken, runTool: async () => ({}), openSocket: () => ({}) as WebSocket })).rejects.toThrow();
    expect(tracks[0].stopped).toBe(true);
    expect(FakeCtx.last?.closed).toBe(true);
    expect(getToken).not.toHaveBeenCalled();
  });
});
