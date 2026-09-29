import { initialMachine, onError, type OralMachine, type OralState } from "./machine";

/**
 * Every way the oral exam can fail, with the machine state it lands in, the
 * error code it carries and the sentence the learner reads. One table, so the
 * screen, the socket and the tests cannot drift apart. Each sentence says what
 * happened and what to do next; none names a status code or an internal part.
 *
 * `source` says where the failure is raised, and `covered` names the test that
 * drives the real cause (tests/oral-failures.test.ts and its neighbours).
 */
export type OralFailure = {
  id: string;
  cause: string;
  /** The machine state the exam is in while this is on screen. */
  state: OralState;
  code: string;
  message: string;
  /** True when only the learner starting again can clear it. */
  fatal: boolean;
  source: "route" | "client" | "socket" | "timer";
};

export const ORAL_FAILURES: readonly OralFailure[] = [
  { id: "mic_denied", cause: "The browser refused microphone access", state: "ERROR", code: "MIC_BLOCKED", fatal: true, source: "client",
    message: "Microphone access is blocked. Allow it in the browser bar, then start again." },
  { id: "no_audio_device", cause: "The browser found no microphone", state: "ERROR", code: "NO_MIC", fatal: true, source: "client",
    message: "This browser did not find a microphone. Plug one in and start again." },
  { id: "insecure_context", cause: "The page is not served over HTTPS, so the browser hides the microphone", state: "ERROR", code: "INSECURE_CONTEXT", fatal: true, source: "client",
    message: "The microphone needs a secure page. Open VIVA at its secure address and start again." },
  { id: "no_audio_worklet", cause: "The browser has no AudioWorklet", state: "ERROR", code: "NO_WORKLET", fatal: true, source: "client",
    message: "This browser cannot start the microphone. Try a current Chrome, Edge, Firefox or Safari." },
  { id: "token_unauthorized", cause: "The voice token request was refused (401 or 403 upstream)", state: "ERROR", code: "AUTH_FAILED", fatal: true, source: "route",
    message: "Voice is not switched on for this deployment. Nothing is faked; try the recorded exam instead." },
  { id: "token_bad_request", cause: "The token endpoint rejected our request (422 upstream)", state: "ERROR", code: "BAD_RESPONSE", fatal: true, source: "route",
    message: "Voice could not be set up. Reload the page; if it happens again, try the recorded exam." },
  { id: "token_rate_limited", cause: "Too many token requests (429, ours or upstream)", state: "ERROR", code: "RATE_LIMITED", fatal: false, source: "route",
    message: "Too many starts at once. Wait a few seconds and start again." },
  { id: "token_upstream_down", cause: "The token endpoint failed (5xx or network)", state: "ERROR", code: "TRANSCRIPTION_FAILED", fatal: false, source: "route",
    message: "The voice service did not answer. Start again in a moment." },
  { id: "token_timeout", cause: "The token endpoint did not answer in eight seconds", state: "ERROR", code: "PROVIDER_TIMEOUT", fatal: false, source: "route",
    message: "The voice service took too long. Start again in a moment." },
  { id: "no_api_key", cause: "ASSEMBLYAI_API_KEY is not set on the server", state: "ERROR", code: "NO_API_KEY", fatal: true, source: "route",
    message: "Voice is not switched on for this deployment. Nothing is faked; try the recorded exam instead." },
  { id: "socket_error", cause: "The socket could not be opened or was refused", state: "ERROR", code: "NETWORK_DOWN", fatal: false, source: "socket",
    message: "You look offline. Reconnect and start again." },
  { id: "socket_closed", cause: "The socket closed in the middle of the exam", state: "RECOVERING", code: "SOCKET_CLOSED", fatal: false, source: "socket",
    message: "The connection dropped. Reconnecting, and your exam carries on from your last answer." },
  { id: "session_lost", cause: "The service refused session.resume, so a new session continues the exam", state: "RECOVERING", code: "SESSION_EXPIRED", fatal: false, source: "socket",
    message: "That exam session expired. Carrying on in a new one from your last answers." },
  { id: "tool_timeout", cause: "A source check took longer than ten seconds", state: "CHECKING_SOURCE", code: "TOOL_TIMEOUT", fatal: false, source: "timer",
    message: "Checking your material took too long, so the examiner will go on without it. Ask again if you want that point checked." },
  { id: "session_ended_early", cause: "The service ended the session without being asked", state: "ENDED", code: "SESSION_ENDED", fatal: false, source: "socket",
    message: "The exam ended early on the service side. Your answers so far are kept; start a new exam to carry on." },
  { id: "tab_hidden", cause: "The tab moved to the background", state: "LISTENING", code: "TAB_HIDDEN", fatal: false, source: "client",
    message: "This tab is in the background and the browser may mute your microphone. Come back to this tab to keep talking." },
  { id: "long_silence", cause: "Nothing was said for a minute", state: "LISTENING", code: "LONG_SILENCE", fatal: false, source: "timer",
    message: "Still there? Say something to carry on, or end the exam." },
];

const BY_CODE = new Map(ORAL_FAILURES.map((f) => [f.code, f]));

export function failureFor(code: string): OralFailure | undefined {
  return BY_CODE.get(code);
}

/** The sentence for a code, or a generic recovery line: never a blank. */
export function oralMessage(code: string | undefined): string {
  return (code && BY_CODE.get(code)?.message) || "Something went wrong with the exam. Start again in a moment.";
}

/**
 * The machine for a failure raised before any socket exists (microphone, token):
 * an idle machine put into ERROR. Failures raised mid-exam reach their state
 * through the socket itself, and the tests drive those real causes.
 */
export function machineFor(failure: OralFailure): OralMachine {
  if (failure.state !== "ERROR") throw new Error(`${failure.id} is raised by the socket, not before it`);
  return onError(initialMachine(), failure.code, failure.fatal);
}
