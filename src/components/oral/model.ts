import type { OralState } from "@/lib/oral/machine";
import { ORAL_FAILURES } from "@/lib/oral/failures";
import { RESUME_WINDOW_SECONDS } from "@/lib/oral/socket";
import type { SessionEntry } from "@/lib/oral/debrief";

/**
 * What the /oral screen shows, as pure functions of the machine state, so the
 * twelve states, the failure screens and the record the debrief is built from
 * can be asserted without a browser.
 */

export type Phase = "idle" | "loading" | "running" | "ended";

/** The state line: the true machine state in words. */
export function stateLine(state: OralState, o: { phase?: Phase; page?: number | null; reason?: string | null } = {}): string {
  if (o.phase === "loading") return "Loading your material";
  switch (state) {
    case "IDLE": return o.phase === "ended" ? "Ended" : "Ready";
    case "CONNECTING": return "Connecting";
    case "READY": return "Session ready";
    case "LISTENING": return "Listening";
    case "USER_SPEAKING": return "Hearing you";
    case "THINKING": return "Thinking";
    case "CHECKING_SOURCE": return o.page != null ? `Checking page ${o.page}` : "Checking your pages";
    case "SPEAKING": return "Speaking";
    case "INTERRUPTED": return "Interrupted, listening";
    case "RECOVERING": return "Reconnecting";
    case "ERROR": return "Stopped";
    case "ENDED": return "Ended";
  }
}

/** One sentence under the state line for the states where the learner needs to know what to do. */
export function stateHint(state: OralState, phase: Phase = "running"): string {
  if (phase === "idle") return "Start when your headphones are on. The examiner speaks first.";
  if (phase === "ended" && state === "IDLE") return "The exam is over. Your debrief is below.";
  switch (state) {
    case "CONNECTING": return "Opening a session with the voice service.";
    case "READY": return "The service is ready. The microphone opens next.";
    case "LISTENING": return "Say your answer. You can interrupt the examiner at any time.";
    case "USER_SPEAKING": return "Keep going. The examiner waits until you stop.";
    case "THINKING": return "The examiner is deciding what to ask next.";
    case "CHECKING_SOURCE": return "The examiner is reading your own pages before it answers. Anything you say meanwhile is held until the check finishes.";
    case "SPEAKING": return "Talk over the examiner to cut in.";
    case "INTERRUPTED": return "The examiner dropped its sentence. Carry on.";
    case "RECOVERING": return `The connection dropped. VIVA tries to resume the session, which the service holds for ${RESUME_WINDOW_SECONDS} seconds. If it cannot, a new session carries on from your last answers.`;
    case "ERROR": return "The exam stopped. Your answers so far are kept.";
    case "ENDED": return "The exam is over. Your debrief is below.";
    default: return "";
  }
}

export type Controls = { start: boolean; end: boolean };

export function controlsFor(phase: Phase, state: OralState, fatal: boolean): Controls {
  const stopped = phase === "idle" || phase === "ended" || state === "ENDED" || (state === "ERROR" && fatal);
  return { start: stopped && phase !== "loading", end: phase === "running" && !stopped };
}

export const SHORTCUT_LABEL = "Alt+Shift+M";

/** True for the start/stop shortcut, kept here so the page and the tests agree. */
export function isShortcut(e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyM";
}

/* ---------------------------- failure screens ---------------------------- */

export type FailureAction = "retry" | "type" | "recorded" | "reload" | "end";

export type FailureView = {
  id: string;
  title: string;
  /** What happened and why, when the cause is known. */
  cause: string;
  /** The next action, in one sentence. */
  message: string;
  /** Blocking failures stop the exam and are announced assertively. The rest are notices. */
  blocking: boolean;
  actions: FailureAction[];
};

const TITLES: Record<string, string> = {
  mic_denied: "Microphone blocked",
  no_audio_device: "No microphone found",
  insecure_context: "This page is not secure",
  no_audio_worklet: "This browser cannot capture audio",
  token_unauthorized: "Voice is not switched on",
  token_bad_request: "Voice could not be set up",
  token_rate_limited: "Too many starts",
  token_upstream_down: "The voice service did not answer",
  token_timeout: "The voice service was too slow",
  no_api_key: "Voice is not switched on",
  socket_error: "You look offline",
  socket_closed: "Connection dropped",
  session_lost: "Session expired",
  tool_timeout: "A source check timed out",
  session_ended_early: "The exam ended early",
  tab_hidden: "This tab is in the background",
  long_silence: "Still there",
};

const ACTIONS: Record<string, FailureAction[]> = {
  mic_denied: ["retry", "type"],
  no_audio_device: ["retry", "type"],
  insecure_context: ["type", "recorded"],
  no_audio_worklet: ["type", "recorded"],
  token_unauthorized: ["recorded", "type"],
  token_bad_request: ["reload", "recorded"],
  token_rate_limited: ["retry"],
  token_upstream_down: ["retry", "type"],
  token_timeout: ["retry", "type"],
  no_api_key: ["recorded", "type"],
  socket_error: ["retry", "type"],
  session_ended_early: ["retry"],
  long_silence: ["end"],
};

const GENERIC: FailureView = {
  id: "generic",
  title: "The exam stopped",
  cause: "Something went wrong that VIVA does not have a specific message for.",
  message: "Something went wrong with the exam. Start again in a moment.",
  blocking: true,
  actions: ["retry", "type"],
};

export function failureViewFor(id: string): FailureView {
  const f = ORAL_FAILURES.find((x) => x.id === id);
  if (!f) return GENERIC;
  return {
    id: f.id,
    title: TITLES[f.id] ?? "The exam stopped",
    cause: f.cause,
    message: f.message,
    blocking: f.state === "ERROR",
    actions: ACTIONS[f.id] ?? [],
  };
}

/** The screen receives sentences (errors are thrown as text), so find the failure that owns the sentence. */
export function failureViewFromMessage(message: string): FailureView {
  const f = ORAL_FAILURES.find((x) => x.message === message);
  return f ? failureViewFor(f.id) : { ...GENERIC, cause: "VIVA reported: " + message.slice(0, 200), message };
}

export function failureViewFromCode(code: string): FailureView {
  const f = ORAL_FAILURES.find((x) => x.code === code);
  return f ? failureViewFor(f.id) : GENERIC;
}

/** The ids the screen can show, in the order of section 6.3 item 6. */
export const FAILURE_IDS: readonly string[] = ORAL_FAILURES.map((f) => f.id);

/* ------------------------- sources and the record ------------------------ */

export type SourceCard = {
  id: string;
  claim: string;
  verdict: "supported" | "contradicted";
  quote: string;
  spans: string[];
  page: number | null;
  passageId: string | null;
  method: "llm" | "lexical";
};

export type ToolOutcome = { entry: SessionEntry | null; source: SourceCard | null; page: number | null };

const GRADES = new Set(["correct", "partial", "incorrect"]);
const VERDICTS = new Set(["supported", "contradicted", "not_in_material"]);
const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Turn one tool result into the record entry the debrief is built from, and the
 * passage card the screen shows. Only verdicts a tool actually returned count;
 * the server re-checks every quote again before it reaches the sheet.
 */
export function outcomeOfTool(name: string, args: Record<string, unknown>, result: unknown, id: string): ToolOutcome {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  if (name === "verify_claim" && typeof r.verdict === "string" && VERDICTS.has(r.verdict)) {
    const claim = str(args.claim);
    if (!claim) return { entry: null, source: null, page: null };
    const page = typeof r.page === "number" && Number.isInteger(r.page) && r.page >= 0 ? r.page : null;
    const verdict = r.verdict as "supported" | "contradicted" | "not_in_material";
    const quote = typeof r.quote === "string" && r.quote ? r.quote.slice(0, 1400) : null;
    const passageId = typeof r.passage_id === "string" && r.passage_id ? r.passage_id.slice(0, 120) : null;
    const concept = str(args.concept, 80).trim();
    const entry: SessionEntry = { kind: "claim", conceptId: concept || null, learner: claim, verdict, quote, page, passageId };
    const spans = Array.isArray(r.quote_spans) ? r.quote_spans.filter((s): s is string => typeof s === "string") : [];
    const source: SourceCard | null =
      verdict !== "not_in_material" && quote
        ? { id, claim, verdict, quote, spans: spans.length ? spans : [quote], page, passageId, method: r.method === "llm" ? "llm" : "lexical" }
        : null;
    return { entry, source, page };
  }
  if (name === "grade_my_answer" && typeof r.verdict === "string" && GRADES.has(r.verdict)) {
    const answer = str(args.answer);
    if (!answer) return { entry: null, source: null, page: null };
    return { entry: { kind: "answer", conceptId: null, learner: answer, grade: r.verdict as "correct" | "partial" | "incorrect" }, source: null, page: null };
  }
  return { entry: null, source: null, page: null };
}

/** Method label on a passage card, in words a student can read. */
export function methodLabel(method: "llm" | "lexical", verdict: "supported" | "contradicted"): string {
  if (method === "lexical") return "Word match only. This is not a confirmation.";
  return verdict === "supported"
    ? "Supported. The quote is an exact match to your page, checked by code."
    : "Contradicted. The quote is an exact match to your page, checked by code.";
}

/** Server-safe: the sentence for a failed debrief request. */
export const DEBRIEF_EMPTY = "No answer was checked in this exam, so there is nothing to grade yet. Start again and answer at least one question.";
