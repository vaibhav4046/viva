"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initialMachine, type OralMachine } from "@/lib/oral/machine";
import type { SessionEntry, SessionRecord } from "@/lib/oral/debrief";
import type { OralTraceEvent } from "@/lib/oral/socket";
import { logEvent } from "@/lib/analytics";
import { voiceMessage } from "@/lib/audio/messages";
import { mintVoiceAgentToken, runOralToolOverHttp, startOralExam, type MicHandle, type OralTurn } from "./mic";
import { deriveDiag, type DiagSummary } from "./diag";
import { loadLastRecord, recordHasContent, requestDebrief, saveLastRecord, type DebriefState } from "./debriefClient";
import {
  failureViewFor,
  failureViewFromCode,
  failureViewFromMessage,
  isShortcut,
  outcomeOfTool,
  controlsFor,
  type FailureAction,
  type FailureView,
  type Phase,
  type SourceCard,
} from "./model";

type SessionConfig = Parameters<typeof startOralExam>[0]["config"];
type SessionResponse = SessionConfig & { subjectId: string; error?: { code?: string; message?: string } };

const MAX_ENTRIES = 80;
/** No exam reaches LISTENING later than this after Start: token, socket and session.ready included. */
export const CONNECT_TIMEOUT_MS = 25_000;
const SESSION_FETCH_TIMEOUT_MS = 15_000;
const NOTICE_MS = 12_000;
const NO_PUNCT_BEFORE = /^[.,!?;:%)\]'"ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â]/;

function subjectParam(): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem("viva.courseId");
  return stored ? `?subjectId=${encodeURIComponent(stored)}` : "";
}

type TraceHost = { __VIVA_ORAL_TRACE__?: OralTraceEvent[] };

/**
 * Everything the /oral page needs, in one place: the machine, the captions, the
 * pages the examiner checked, the record the debrief is built from, failures
 * and notices, the typed mode, the diagnostics trace and the debrief request.
 * The screen itself is presentational (OralScreen).
 */
export function useOralSession(opts: { diag: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [machine, setMachine] = useState<OralMachine>(initialMachine);
  const [lines, setLines] = useState<OralTurn[]>([]);
  const [examinerText, setExaminerText] = useState("");
  const [examinerCut, setExaminerCut] = useState(false);
  const [sources, setSources] = useState<SourceCard[]>([]);
  const [page, setPage] = useState<number | null>(null);
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [notice, setNotice] = useState<FailureView | null>(null);
  const [offline, setOffline] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [typed, setTyped] = useState(false);
  const [debrief, setDebrief] = useState<DebriefState>({ status: "idle" });
  const [diag, setDiag] = useState<DiagSummary>(() => deriveDiag([]));

  const micRef = useRef<MicHandle | null>(null);
  const subjectRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const entriesRef = useRef<SessionEntry[]>([]);
  const startedIsoRef = useRef<string>(new Date().toISOString());
  const replyRef = useRef<string>("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const summaryRef = useRef<{ turns: number; interruptions: number } | null>(null);
  /** Bumped by every Start, End and Type instead, so a start that is still waiting on the microphone prompt can tell it was abandoned. */
  const attemptRef = useRef(0);
  const reachedListeningRef = useRef(false);

  const readLevels = useCallback(() => micRef.current?.levels() ?? { learner: 0, examiner: 0 }, []);

  const [entryCount, setEntryCount] = useState(0);
  const addEntry = useCallback((entry: SessionEntry) => {
    entriesRef.current = [...entriesRef.current, entry].slice(-MAX_ENTRIES);
    setEntryCount(entriesRef.current.length);
  }, []);

  const showNotice = useCallback((view: FailureView, autoClear: boolean) => {
    clearTimeout(noticeTimer.current);
    setNotice(view);
    if (autoClear) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  useEffect(() => {
    const sync = () => setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // A notice about the tab clears when the learner comes back to it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setNotice((n) => (n?.id === "tab_hidden" ? null : n));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Speech clears the "still there" prompt.
  useEffect(() => {
    if (machine.state === "USER_SPEAKING" || machine.state === "SPEAKING") setNotice((n) => (n?.id === "long_silence" ? null : n));
  }, [machine.state]);

  // Teardown on unmount: an open socket holds a billable session and the mic light.
  useEffect(
    () => () => {
      micRef.current?.cancel();
      micRef.current = null;
      clearTimeout(noticeTimer.current);
    },
    []
  );

  // Diagnostics: poll the trace the socket writes, only when ?diag=1 and only while a session exists.
  useEffect(() => {
    if (!opts.diag) return;
    const id = setInterval(() => {
      const trace = (globalThis as TraceHost).__VIVA_ORAL_TRACE__;
      if (trace && trace.length) setDiag(deriveDiag(trace));
    }, 500);
    return () => clearInterval(id);
  }, [opts.diag]);

  const buildRecord = useCallback((): SessionRecord => {
    const s = summaryRef.current;
    const answers = entriesRef.current.filter((e) => e.kind === "answer").length;
    return {
      sessionId: sessionIdRef.current ?? `oral_${Date.now().toString(36)}`,
      startedAt: startedIsoRef.current,
      userTurns: Math.min(1000, s ? s.turns : answers),
      interruptions: Math.min(1000, s ? s.interruptions : 0),
      entries: entriesRef.current,
    };
  }, []);

  const showDebrief = useCallback(async () => {
    const record = buildRecord();
    if (!recordHasContent(record)) {
      setDebrief({ status: "empty" });
      return;
    }
    setDebrief({ status: "loading" });
    const subjectId = subjectRef.current ?? "";
    saveLastRecord(subjectId, record);
    try {
      setDebrief({ status: "ready", debrief: await requestDebrief(subjectId, record) });
    } catch (e) {
      setDebrief({ status: "error", message: e instanceof Error ? e.message : "The debrief could not be built. Try again in a moment." });
    }
  }, [buildRecord]);

  const begin = useCallback(async () => {
    // A hot mic from an earlier attempt must never survive into a new one.
    micRef.current?.cancel();
    micRef.current = null;
    const attempt = ++attemptRef.current;
    reachedListeningRef.current = false;
    setFailure(null);
    setNotice(null);
    setDebrief({ status: "idle" });
    setLines([]);
    setExaminerText("");
    setExaminerCut(false);
    setSources([]);
    setPage(null);
    setTyped(false);
    setMachine(initialMachine());
    entriesRef.current = [];
    setEntryCount(0);
    summaryRef.current = null;
    sessionIdRef.current = null;
    replyRef.current = "";
    startedIsoRef.current = new Date().toISOString();
    setPhase("loading");
    if (opts.diag) {
      const host = globalThis as TraceHost;
      host.__VIVA_ORAL_TRACE__ = [{ t: performance.now(), kind: "ui.start" }];
      setDiag(deriveDiag(host.__VIVA_ORAL_TRACE__));
    }

    const fail = (view: FailureView) => {
      if (attemptRef.current !== attempt) return;
      micRef.current?.cancel();
      micRef.current = null;
      setFailure(view);
      setPhase("idle");
    };

    try {
      const res = await fetch(`/api/oral/session${subjectParam()}`, { cache: "no-store", signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS) });
      const body = (await res.json().catch(() => null)) as SessionResponse | null;
      if (attemptRef.current !== attempt) return;
      if (!res.ok || !body?.system_prompt) {
        const code = body?.error?.code ?? "ORAL_UNAVAILABLE";
        const sentence = body?.error?.message ?? voiceMessage(code);
        fail({ ...failureViewFromMessage(sentence), title: "The exam could not open", cause: "The server could not build the exam from your subject", actions: ["retry", "type"] });
        return;
      }
      subjectRef.current = body.subjectId;
      const subjectId = body.subjectId;
      const handle = await startOralExam(
        {
          config: {
            system_prompt: body.system_prompt,
            greeting: body.greeting,
            tools: body.tools,
            keyterms: body.keyterms,
            language_codes: body.language_codes,
            transcription_mode: body.transcription_mode,
            turn_detection: body.turn_detection,
          },
          subjectId,
          onState: (m) => {
            if (attemptRef.current !== attempt) return;
            if (m.sessionId) sessionIdRef.current = m.sessionId;
            if (m.state === "LISTENING" || m.state === "SPEAKING") reachedListeningRef.current = true;
            setMachine(m);
          },
          onTurn: (turn) => {
            setLines((prev) => [...prev, turn]);
            if (turn.speaker === "agent") {
              setExaminerText(turn.text);
              setExaminerCut(!!turn.interrupted);
              replyRef.current = "";
            }
          },
          onAgentDelta: (word, replyId) => {
            setExaminerCut(false);
            setExaminerText((prev) => {
              if (replyRef.current !== replyId) {
                replyRef.current = replyId;
                return word;
              }
              return NO_PUNCT_BEFORE.test(word) ? prev + word : `${prev} ${word}`;
            });
          },
          onError: (message) => fail(failureViewFromMessage(message)),
          onNotice: (_message, code) => {
            const view = failureViewFromCode(code);
            const sticky = code === "TAB_HIDDEN" || code === "LONG_SILENCE" || code === "SESSION_ENDED";
            showNotice(view, !sticky);
          },
          onEnded: (summary) => {
            if (attemptRef.current !== attempt) return;
            summaryRef.current = { turns: summary.turns, interruptions: summary.interruptions };
            // The service can end the session without being asked. Release the microphone either way.
            micRef.current?.cancel();
            micRef.current = null;
            setPhase("ended");
            logEvent("oral_ended", { turns: summary.turns, tools: summary.toolCalls, dropped: summary.discards });
            void showDebrief();
          },
        },
        {
          getToken: mintVoiceAgentToken,
          runTool: async (name, args, callId) => {
            setPage(null);
            const result = await runOralToolOverHttp(name, args, callId, { subjectId, sessionId: sessionIdRef.current });
            const outcome = outcomeOfTool(name, args, result, callId);
            if (outcome.entry) addEntry(outcome.entry);
            if (outcome.source) setSources((prev) => [outcome.source as SourceCard, ...prev]);
            if (outcome.page != null) setPage(outcome.page);
            return result;
          },
        }
      );
      if (attemptRef.current !== attempt) {
        // Type instead or End was chosen while the microphone prompt was open. Do not start the exam.
        handle.cancel();
        return;
      }
      micRef.current = handle;
      setStartedAt(Date.now());
      setPhase("running");
      logEvent("oral_started", { subjectId });
    } catch (e) {
      fail(failureViewFromMessage(e instanceof Error && e.message ? e.message : voiceMessage("NO_MIC")));
    }
  }, [opts.diag, addEntry, showDebrief, showNotice]);

  const end = useCallback(async () => {
    // With no microphone handle yet, End abandons a start that is still waiting on the browser prompt.
    if (!micRef.current) attemptRef.current += 1;
    const handle = micRef.current;
    micRef.current = null;
    await handle?.stop();
    setPhase("ended");
  }, []);

  const openTyped = useCallback(async () => {
    attemptRef.current += 1;
    if (micRef.current) await end();
    else setPhase("idle");
    setFailure(null);
    setNotice(null);
    setDebrief({ status: "idle" });
    if (!subjectRef.current && typeof window !== "undefined") subjectRef.current = window.localStorage.getItem("viva.courseId");
    setTyped(true);
  }, [end]);

  const finishTyped = useCallback(() => {
    setTyped(false);
    setPhase("ended");
    void showDebrief();
  }, [showDebrief]);

  const onFailureAction = useCallback(
    (a: FailureAction) => {
      if (a === "retry") void begin();
      else if (a === "type") void openTyped();
      else if (a === "end") void end();
      else if (a === "reload") window.location.reload();
    },
    [begin, openTyped, end]
  );

  // Connect watchdog: token, socket and session.ready have no timeout of their own.
  useEffect(() => {
    if (phase !== "running") return;
    const id = setTimeout(() => {
      if (reachedListeningRef.current) return;
      micRef.current?.cancel();
      micRef.current = null;
      attemptRef.current += 1;
      setFailure(failureViewFor("token_timeout"));
      setPhase("idle");
    }, CONNECT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // Alt+Shift+M starts or ends the exam. Any modifier chord, so it never steals a plain key.
  const latest = useRef({ machine, phase, begin, end });
  latest.current = { machine, phase, begin, end };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      const { machine: m, phase: p } = latest.current;
      const c = controlsFor(p, m.state, m.fatal);
      if (c.start) void latest.current.begin();
      else if (c.end) void latest.current.end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // /oral/debrief rebuilds the sheet from the last record.
  const loadLast = useCallback(async () => {
    const last = loadLastRecord();
    if (!last || !recordHasContent(last.record)) {
      setDebrief({ status: "empty" });
      return;
    }
    subjectRef.current = last.subjectId;
    setDebrief({ status: "loading" });
    try {
      setDebrief({ status: "ready", debrief: await requestDebrief(last.subjectId, last.record) });
    } catch (e) {
      setDebrief({ status: "error", message: e instanceof Error ? e.message : "The debrief could not be built. Try again in a moment." });
    }
  }, []);

  const shownFailure = useMemo<FailureView | null>(() => failure, [failure]);
  const shownNotice = useMemo<FailureView | null>(() => {
    if (notice) return notice;
    return offline && phase !== "running" ? { ...failureViewFor("socket_error"), blocking: false, actions: [] } : null;
  }, [notice, offline, phase]);

  return {
    phase, machine, lines, examinerText, examinerCut, sources, page, startedAt, typed, debrief, diag,
    failure: shownFailure, notice: shownNotice,
    canDebrief: entryCount > 0,
    subjectId: subjectRef.current,
    readLevels,
    begin, end, openTyped, finishTyped, showDebrief, loadLast, addEntry, onFailureAction,
  };
}
