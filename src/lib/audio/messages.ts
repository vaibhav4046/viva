/**
 * One coded error, one plain sentence. Shared by the route and the mic button
 * so the learner reads the same words wherever a failure surfaces, and so a
 * provider stack trace can never reach the screen.
 *
 * Every sentence says what happened and what to do next; none of them name a
 * status code, a vendor, or an internal component.
 */

export const VOICE_MESSAGES: Record<string, string> = {
  NO_API_KEY: "Voice is not switched on for this deployment. Type instead — nothing is faked.",
  NO_DICTATION_URL: "Voice is not switched on for this deployment. Type instead — nothing is faked.",
  MIC_BLOCKED: "Microphone access is blocked. Allow it in the browser bar, or type instead.",
  NO_MIC: "This browser will not give VIVA a microphone. Type instead.",
  NO_WORKLET: "This browser could not start the microphone. Type instead.",
  // Held long enough to say something, and the input device delivered nothing:
  // muted at the operating system, a dead virtual input, a headset that never
  // finished connecting. Naming the microphone matters because the old
  // sentence for this state was AUDIO_TOO_SHORT's "hold a little longer",
  // which is false and cannot be fixed by doing it — see `shortClipCode` in
  // src/lib/audio/worklet.ts.
  NO_AUDIO: "Your microphone sent no sound. Check it is not muted, or pick a different input — or type instead.",
  NETWORK_DOWN: "You look offline. Reconnect and hold the mic again, or type instead.",
  EMPTY_AUDIO: "No audio came through. Hold the mic and speak.",
  // A clip that recorded silence: the commonest real failure (muted headset,
  // wrong input device) and the one that used to park the learner in a review
  // box that promised to send and never did.
  NO_SPEECH: "I did not catch anything — hold the mic and try again, or type instead.",
  AUDIO_TOO_SHORT: "That was too short. Hold a little longer and speak.",
  AUDIO_TOO_LONG: "That was over two minutes. Say it in a shorter burst.",
  AUDIO_TOO_LARGE: "That clip was too big. Say it in a shorter burst.",
  UNSUPPORTED_FORMAT: "That audio format cannot be read. Reload the page and try again.",
  BAD_AUDIO: "That recording could not be read. Try again.",
  DICTATION_BAD_REQUEST: "That recording could not be read. Try again.",
  BAD_RESPONSE: "Nothing came back for that clip. Try again.",
  AUTH_FAILED: "Voice is not switched on for this deployment. Type instead — nothing is faked.",
  RATE_LIMITED: "Too many clips at once. Wait a few seconds and try again.",
  PROVIDER_BUSY: "AssemblyAI is busy. Try again in a moment.",
  PROVIDER_TIMEOUT: "That took too long. A shorter clip usually goes through.",
  TRANSCRIPTION_FAILED: "That clip did not come back. Try again.",
};

export function voiceMessage(code: string | undefined): string {
  return (code && VOICE_MESSAGES[code]) || "That clip did not come back. Try again.";
}

/**
 * The rewrite came back too short to be a tidy-up of the words it was tidying,
 * so the route sent the raw words instead. Written into `llmError` in place of
 * the provider's own, because from the learner's side it is the same fact — no
 * usable cleaned version — and the review panel already checks that one field.
 * See `isCleanup` in src/app/api/voice/transcribe/route.ts for the bound.
 */
export const CLEANUP_DROPPED = "cleanup_dropped_the_clip";

/**
 * What the review panel says when the tidied version is not the one on screen.
 * Two different reasons, two different sentences: the rewrite failed upstream,
 * or it came back missing most of the clip and was refused here.
 */
export function cleanupNote(llmError: string | null | undefined): string | null {
  if (!llmError) return null;
  if (llmError === CLEANUP_DROPPED)
    return "The tidy-up came back missing most of your words, so this is exactly what you said.";
  return "Showing exactly what you said.";
}

/**
 * The same failures, said for the live-words socket instead of the clip.
 *
 * These cannot borrow VOICE_MESSAGES. Those sentences all end in some form of
 * "try again", which is right when the turn is lost and wrong here: when the
 * socket drops, the microphone is still recording and the buffered clip still
 * goes to Dictation, so the learner should carry on talking. Telling them to
 * try again would make them abandon a clip that is about to succeed.
 */
const STILL_RECORDING = "Keep talking — this clip is still recording, and it will be transcribed when you let go.";

export const LIVE_MESSAGES: Record<string, string> = {
  PROVIDER_BUSY: `Live words are not available right now: AssemblyAI has too many sessions open. ${STILL_RECORDING}`,
  TRANSCRIPTION_FAILED: `Live words stopped. ${STILL_RECORDING}`,
  NETWORK_DOWN: `Live words stopped because the connection dropped. ${STILL_RECORDING}`,
};

export function liveMessage(code: string | undefined): string {
  return (code && LIVE_MESSAGES[code]) || `Live words stopped. ${STILL_RECORDING}`;
}

/**
 * Codes where "keep talking" would be the lie instead: the whole voice path is
 * off, so the buffered clip is not going to rescue the turn either.
 */
const VOICE_OFF = new Set(["NO_API_KEY", "AUTH_FAILED", "NO_DICTATION_URL"]);

/**
 * The sentence for a live socket that never got a token.
 *
 * Measured 2026-09-13 against the dev server: killing `/api/voice/stream-token`
 * mid-hold put "You look offline. Reconnect and hold the mic again, or type
 * instead." on screen while the microphone was still recording, and the clip
 * then went to Dictation and came back fine. That is the exact failure the
 * LIVE_MESSAGES note above exists to prevent — the learner is told to abandon a
 * clip that is about to succeed — and it arrived through the token path, which
 * was throwing VOICE_MESSAGES sentences. A token failure that means voice is
 * off keeps its sentence, because then it is true; everything else keeps them
 * talking.
 */
export function liveTokenMessage(code: string | undefined): string {
  return VOICE_OFF.has(code ?? "") ? voiceMessage(code) : liveMessage(code);
}
