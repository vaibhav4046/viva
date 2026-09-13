import { describe, expect, it } from "vitest";
import {
  LIVE_MESSAGES,
  VOICE_MESSAGES,
  liveMessage,
  liveTokenMessage,
  voiceMessage,
} from "@/lib/audio/messages";
import { DEAD_INPUT_MS, shortClipCode } from "@/lib/audio/worklet";

/**
 * A failure the student cannot read is the same as no failure at all. These
 * cover the two ways that happened: a sentence that was true of a different
 * problem, and a sentence borrowed from the wrong path.
 */

/** Every code any voice path can hand the mic button. Grown, never trimmed:
 *  a new code with no sentence of its own falls through to the generic one,
 *  and that is the failure this list is here to catch. */
const EVERY_CODE = [
  // src/app/api/voice/transcribe/route.ts and src/lib/audio/wav.ts
  "EMPTY_AUDIO", "AUDIO_TOO_LARGE", "UNSUPPORTED_FORMAT", "BAD_AUDIO",
  "AUDIO_TOO_SHORT", "AUDIO_TOO_LONG", "NO_SPEECH", "RATE_LIMITED",
  // src/lib/assemblyai.ts
  "NO_API_KEY", "NO_DICTATION_URL", "AUTH_FAILED", "PROVIDER_BUSY",
  "PROVIDER_TIMEOUT", "TRANSCRIPTION_FAILED", "BAD_RESPONSE",
  "DICTATION_BAD_REQUEST",
  // src/lib/audio/worklet.ts and the fetch itself
  "NO_MIC", "MIC_BLOCKED", "NO_WORKLET", "NO_AUDIO", "NETWORK_DOWN",
] as const;

const GENERIC = voiceMessage(undefined);

describe("every voice failure says something a student can act on", () => {
  // An explicit entry, not the generic fallback by accident. TRANSCRIPTION_FAILED
  // is allowed to read the same as the fallback — the fallback IS its sentence —
  // but it still has to be spelled out here, or a code added later inherits it
  // silently and nobody notices the student was told the wrong thing.
  it.each(EVERY_CODE)("%s has a sentence of its own", (code) => {
    expect(VOICE_MESSAGES[code], `${code} has no sentence`).toBeTruthy();
  });

  it("still answers a code it has never seen rather than nothing", () => {
    expect(voiceMessage("SOME_FUTURE_CODE")).toBe(GENERIC);
    expect(GENERIC.trim().length).toBeGreaterThan(0);
  });

  it("names no status code, path or vendor internals", () => {
    for (const sentence of Object.values(VOICE_MESSAGES)) {
      expect(sentence).not.toMatch(/\b[45]\d\d\b/);
      expect(sentence).not.toMatch(/\/api\/|https?:|[A-Z]{3,}_[A-Z]/);
    }
  });
});

describe("a hold that captured nothing is not a hold that was too short", () => {
  it("blames the release only when they actually released fast", () => {
    expect(shortClipCode(0)).toBe("AUDIO_TOO_SHORT");
    expect(shortClipCode(DEAD_INPUT_MS - 1)).toBe("AUDIO_TOO_SHORT");
  });

  // The judged state: permission granted, "Listening — release" on screen, the
  // timer running, and an input device that delivered no samples at all.
  it("blames the microphone once the hold was long enough to say something", () => {
    expect(shortClipCode(DEAD_INPUT_MS)).toBe("NO_AUDIO");
    expect(shortClipCode(7_000)).toBe("NO_AUDIO");
  });

  it("does not tell them to hold longer when holding longer cannot help", () => {
    expect(voiceMessage(shortClipCode(7_000))).not.toMatch(/longer/i);
    expect(voiceMessage(shortClipCode(7_000))).toMatch(/microphone/i);
  });
});

describe("losing the live words does not tell a student to abandon the clip", () => {
  it("keeps them talking, because the clip is still recording", () => {
    for (const code of ["NETWORK_DOWN", "PROVIDER_BUSY", "TRANSCRIPTION_FAILED"]) {
      expect(liveTokenMessage(code)).toBe(LIVE_MESSAGES[code]);
      expect(liveTokenMessage(code)).toMatch(/Keep talking/);
    }
  });

  it("keeps them talking for a reason it has never seen either", () => {
    expect(liveMessage(undefined)).toMatch(/Keep talking/);
    expect(liveTokenMessage("SOME_FUTURE_CODE")).toMatch(/Keep talking/);
  });

  it("never borrows a sentence that ends the turn", () => {
    for (const code of ["NETWORK_DOWN", "RATE_LIMITED", "PROVIDER_TIMEOUT", undefined]) {
      expect(liveTokenMessage(code)).not.toBe(voiceMessage(code));
    }
  });

  it("still says voice is off when voice really is off", () => {
    for (const code of ["NO_API_KEY", "AUTH_FAILED", "NO_DICTATION_URL"]) {
      expect(liveTokenMessage(code)).toBe(voiceMessage(code));
      expect(liveTokenMessage(code)).toMatch(/not switched on/);
    }
  });
});
