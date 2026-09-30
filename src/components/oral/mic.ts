"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { openOralSocket, ORAL_SAMPLE_RATE, type OralSocket } from "@/lib/oral/socket";
import type { OralMachine } from "@/lib/oral/machine";
import { voiceMessage } from "@/lib/audio/messages";
import { failureFor, oralMessage } from "@/lib/oral/failures";
import { meterLevel, rmsOf } from "./levels";

/** The exam's own sentence for a code when it has one, the dictation sentence otherwise. */
const failureText = (code: string | undefined): string => (code && failureFor(code) ? oralMessage(code) : voiceMessage(code));

/**
 * The microphone side of the oral exam.
 *
 * Separated from the page for the same reason `stream.ts` separates capture
 * from transport: a bug in audio plumbing and a bug in exam logic are found in
 * different ways, and the exam logic is the part with tests. This file owns
 * getUserMedia, the AudioContext and the 24 kHz worklet; the socket owns the
 * protocol; the page owns the screen.
 *
 * The 24 kHz is not a detail. `/worklets/pcm16.js` normally resamples to 16 kHz
 * for Dictation, and the Voice Agent socket is a different product with its own
 * input contract at 24 kHz. Sending 16 kHz to it would still connect and still
 * produce audio, just worse, with no error anywhere, which is the worst kind
 * of wrong.
 */

/** ~100 ms at 24 kHz. Matches the socket's frame size. */
const FRAME_SAMPLES = 2400;

export type OralTurn = {
  speaker: "user" | "agent";
  text: string;
  /** Set when the student cut the agent off. */
  interrupted?: boolean;
};

export type MicHandle = {
  /** Stop capture and let the socket tear down. */
  stop: () => Promise<void>;
  /** Tear down without a clean end (navigation, error). */
  cancel: () => void;
  /** True while the mic is actually pushing frames. */
  readonly live: boolean;
  /** Current 0..1 levels, read from analysers on the real microphone and the real playback. */
  levels: () => { learner: number; examiner: number };
};

export type OralSessionDeps = {
  getToken: () => Promise<string>;
  runTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  /** Test seam. Defaults to the real worklet. */
  openSocket?: (url: string) => WebSocket;
  /** Test seam. Defaults to real audio playback. */
  createPlayback?: () => { play: (b64: string) => void; flush: () => void; close: () => void };
};

export type StartOralArgs = {
  config: Parameters<typeof openOralSocket>[0]["config"];
  subjectId: string;
  onState: (m: OralMachine) => void;
  onTurn: (turn: OralTurn) => void;
  /** One word of the examiner's line, for live captions. */
  onAgentDelta?: (word: string, replyId: string) => void;
  onError: (message: string) => void;
  /** The exam goes on: a continued session, a hidden tab, a long silence. Show it, do not stop. */
  onNotice?: (message: string, code: string) => void;
  onEnded: (summary: { turns: number; toolCalls: number; interruptions: number; discards: number }) => void;
};

/**
 * Decode base64 PCM16 straight into an AudioContext, and make barge-in cheap.
 *
 * The queue is the whole point. When the student interrupts, the docs say to
 * flush the playback buffer, and on a naive implementation that means the
 * already-decoded audio keeps playing, so a student who barges in still has to
 * listen to another two seconds of the answer they just cut off. Every chunk is
 * therefore scheduled with an explicit start time and tracked, so `flush()` can
 * cancel it all.
 */
export function createPlayback(ctx: AudioContext, out?: AudioNode): { play: (b64: string) => void; flush: () => void; close: () => void } {
  let nextAt = 0;
  let scheduled: AudioBufferSourceNode[] = [];
  let closed = false;

  return {
    play(b64: string) {
      if (closed) return;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // 16-bit mono at 24 kHz: the output format is the session's, declared
        // once in session.update, so it is not a per-chunk negotiation.
        const pcm = new Int16Array(bytes.buffer);
        const buffer = ctx.createBuffer(1, pcm.length, ORAL_SAMPLE_RATE);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(out ?? ctx.destination);
        // Schedule against the clock so a flush can cancel precisely, rather
        // than racing a queue of already-started nodes.
        const at = Math.max(ctx.currentTime, nextAt);
        node.start(at);
        nextAt = at + buffer.duration;
        scheduled.push(node);
        // Drop finished nodes so a long exam does not accumulate them.
        node.onended = () => {
          scheduled = scheduled.filter((n) => n !== node);
        };
      } catch {
        // A malformed chunk costs one word of audio, not the exam.
      }
    },
    flush() {
      for (const node of scheduled) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          // Already stopped.
        }
      }
      scheduled = [];
      nextAt = 0;
    },
    close() {
      closed = true;
      this.flush();
    },
  };
}

/**
 * Open the microphone and the socket together.
 *
 * Order matters and is not negotiable: the AudioContext must be built inside
 * the caller's user gesture, or the browser suspends it and the worklet never
 * runs. So this is called from a click handler and does its own getUserMedia
 * rather than being handed a stream.
 */
export async function startOralExam(args: StartOralArgs, deps: OralSessionDeps): Promise<MicHandle> {
  if (typeof window === "undefined") throw new Error(oralMessage("NO_MIC"));
  // Browsers hide getUserMedia on a page that is not secure, so say that rather than "no microphone".
  if (window.isSecureContext === false) throw new Error(oralMessage("INSECURE_CONTEXT"));
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(oralMessage("NO_MIC"));

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    throw new Error(oralMessage(name === "NotFoundError" || name === "DevicesNotFoundError" ? "NO_MIC" : "MIC_BLOCKED"));
  }

  // The playback context and the capture context are the same one. Two
  // AudioContexts on one page is legal but means two hardware contexts and,
  // on a phone, a measurable battery cost for no benefit.
  const ctx = new AudioContext({ sampleRate: ORAL_SAMPLE_RATE });
  let node: AudioWorkletNode | null = null;
  let torn = false;

  // A context can start suspended (autoplay policy) or be suspended or
  // interrupted later (a call, another tab taking the audio device). A
  // suspended context produces no frames and no error, so the exam would sit
  // in LISTENING hearing nothing: ask for it to run now, inside the user
  // gesture, and again on every state change.
  const resumeIfStopped = () => {
    if (torn) return;
    if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") void ctx.resume().catch(() => {});
  };
  ctx.onstatechange = resumeIfStopped;
  resumeIfStopped();

  // The examiner's meter reads the same signal the speakers get.
  const outAnalyser = ctx.createAnalyser();
  outAnalyser.fftSize = 1024;
  outAnalyser.connect(ctx.destination);
  const inAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 1024;
  const inBuf = new Float32Array(inAnalyser.fftSize);
  const outBuf = new Float32Array(outAnalyser.fftSize);
  const level = (a: AnalyserNode, buf: Float32Array<ArrayBuffer>) => {
    a.getFloatTimeDomainData(buf);
    return meterLevel(rmsOf(buf));
  };

  const playback = (deps.createPlayback ?? (() => createPlayback(ctx, outAnalyser)))();

  const teardown = () => {
    if (torn) return;
    torn = true;
    ctx.onstatechange = null;
    node?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    playback.close();
    void ctx.close().catch(() => {});
  };

  try {
    await ctx.audioWorklet.addModule("/worklets/pcm16.js");
  } catch {
    teardown();
    throw new Error(oralMessage("NO_WORKLET"));
  }

  // Build the graph BEFORE the socket exists. A browser that refuses the source
  // or the worklet node would otherwise leave a live session (and a billed
  // one) behind an exam that never started, with the microphone still open.
  let socketRef: OralSocket | null = null;
  try {
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm16-24k", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<{ type: string; frame?: Int16Array }>) => {
      if (e.data.type === "pcm" && e.data.frame) socketRef?.sendAudio(e.data.frame);
    };

    // The worklet only runs while its output reaches the destination, so the
    // chain has to terminate there, through a muted gain, or the student's own
    // voice is played back into the room and picked up again as an interruption.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    source.connect(inAnalyser);
    node.connect(mute);
    mute.connect(ctx.destination);
  } catch {
    teardown();
    throw new Error(oralMessage("NO_WORKLET"));
  }

  const socket: OralSocket = openOralSocket({
    config: args.config,
    subjectId: args.subjectId,
    getToken: deps.getToken,
    runTool: deps.runTool,
    ...(deps.openSocket ? { openSocket: deps.openSocket } : {}),
    playAudio: (chunk) => playback.play(chunk),
    flushAudio: () => playback.flush(),
    onState: args.onState,
    onTranscript: (text, speaker, interrupted) => args.onTurn({ speaker, text, interrupted }),
    ...(args.onAgentDelta ? { onAgentDelta: args.onAgentDelta } : {}),
    onError: args.onError,
    ...(args.onNotice ? { onNotice: args.onNotice } : {}),
    onEnded: args.onEnded,
  });
  socketRef = socket;

  return {
    get live() {
      return !torn;
    },
    levels() {
      if (torn) return { learner: 0, examiner: 0 };
      return { learner: level(inAnalyser, inBuf as Float32Array<ArrayBuffer>), examiner: level(outAnalyser, outBuf as Float32Array<ArrayBuffer>) };
    },
    async stop() {
      // Flush the worklet's partial frame first: the last word of a sentence
      // lives in it, and that is the word the student is watching for.
      try {
        node?.port.postMessage("flush");
        await new Promise((r) => setTimeout(r, 60));
      } catch {
        // A wedged worklet must not block the exit.
      }
      teardown();
      await socket.end();
    },
    cancel() {
      teardown();
      socket.cancel();
    },
  };
}

/** Mint a Voice Agent token from our own origin. The key never comes with it. */
export async function mintVoiceAgentToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/voice-agent/token", { cache: "no-store" });
  } catch {
    throw new Error(failureText("NETWORK_DOWN"));
  }
  const body = (await res.json().catch(() => null)) as { token?: string; error?: { code?: string } } | null;
  if (!res.ok || typeof body?.token !== "string") {
    throw new Error(failureText(body?.error?.code ?? "NO_API_KEY"));
  }
  return body.token;
}

/** Run one tool on our server. The socket never holds a database handle. */
export async function runOralToolOverHttp(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  ctx: { subjectId: string; sessionId?: string | null }
): Promise<unknown> {
  const res = await fetch("/api/oral/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callId,
      name,
      arguments: args,
      subjectId: ctx.subjectId,
      sessionId: ctx.sessionId ?? null,
    }),
  });
  const body = (await res.json().catch(() => null)) as { result?: unknown; isError?: boolean } | null;
  if (!res.ok) {
    // Surface the server's own sentence; the agent can apologise with it.
    throw new Error(voiceMessage((body as { error?: { code?: string } } | null)?.error?.code));
  }
  return body?.result ?? null;
}

export type { OralMachine };
