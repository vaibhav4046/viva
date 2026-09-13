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
  NO_AUDIO: "No audio came through. Hold the mic and speak.",
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
  return (code && LIVE_MESSAGES[code]) || "Live words stopped.";
}
