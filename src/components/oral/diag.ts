import type { OralTraceEvent } from "@/lib/oral/socket";

/**
 * The diagnostics drawer's numbers, derived from the trace the socket writes
 * while ?diag=1 is on (globalThis.__VIVA_ORAL_TRACE__). Every value comes from
 * an event that happened in this session, stamped by performance.now().
 * Nothing is prefilled: with no events every field is null or empty.
 *
 * What each number measures is stated in the label the drawer prints, because
 * a latency without its endpoints is a claim nobody can check.
 */

export type DiagSummary = {
  events: number;
  /** ui.start (the click) to the first session.ready. */
  toSessionReadyMs: number | null;
  /** ui.start to the first reply.audio chunk handed to playback. */
  toFirstAudioMs: number | null;
  /** input.speech.started received while speaking, to playback flushed. */
  bargeIns: { atMs: number; stopMs: number }[];
  /** tool.http.start to tool.http.end, per call. */
  tools: { name: string; ms: number; ok: boolean; atMs: number }[];
  turns: number;
  partials: { atMs: number; text: string }[];
  socket: { atMs: number; label: string }[];
};

const num = (v: number): number => Math.round(v);
const isRecv = (e: OralTraceEvent, type: string) => e.kind === "ws.recv" && e.type === type;

const SOCKET_KINDS = new Set(["ws.connect", "ws.open", "ws.close", "tab.hidden", "test.drop_socket", "tool.timeout"]);
const SOCKET_RECV = new Set(["session.ready", "session.ended", "session.error", "reply.done"]);

export function deriveDiag(trace: readonly OralTraceEvent[]): DiagSummary {
  const start = trace.find((e) => e.kind === "ui.start") ?? trace[0];
  const t0 = start ? start.t : 0;
  const at = (e: OralTraceEvent) => num(e.t - t0);

  const ready = trace.find((e) => isRecv(e, "session.ready"));
  const audio = trace.find((e) => e.kind === "audio.play");

  const bargeIns: DiagSummary["bargeIns"] = [];
  trace.forEach((e, i) => {
    if (e.kind !== "barge_in.flush.end") return;
    for (let j = i - 1; j >= 0; j--) {
      if (isRecv(trace[j], "input.speech.started")) {
        bargeIns.push({ atMs: at(e), stopMs: Math.round((e.t - trace[j].t) * 10) / 10 });
        return;
      }
    }
  });

  const tools: DiagSummary["tools"] = [];
  for (const s of trace.filter((e) => e.kind === "tool.http.start")) {
    const end = trace.find(
      (e) => e.t >= s.t && e.call_id === s.call_id && (e.kind === "tool.http.end" || e.kind === "tool.http.error" || e.kind === "tool.timeout")
    );
    if (end) tools.push({ name: String(s.name ?? "tool"), ms: num(end.t - s.t), ok: end.kind === "tool.http.end", atMs: at(s) });
  }

  const partials = trace
    .filter((e) => isRecv(e, "transcript.user.delta") && typeof e.text === "string")
    .map((e) => ({ atMs: at(e), text: String(e.text) }))
    .slice(-40);

  const socket = trace
    .filter((e) => SOCKET_KINDS.has(e.kind) || (e.kind === "ws.recv" && SOCKET_RECV.has(String(e.type))))
    .map((e) => ({
      atMs: at(e),
      label: e.kind === "ws.recv" ? `${String(e.type)}${e.status ? ` (${String(e.status)})` : ""}${e.code ? ` ${String(e.code)}` : ""}` : `${e.kind}${e.code ? ` ${String(e.code)}` : ""}`,
    }))
    .slice(-60);

  return {
    events: trace.length,
    toSessionReadyMs: ready && start ? num(ready.t - start.t) : null,
    toFirstAudioMs: audio && start ? num(audio.t - start.t) : null,
    bargeIns,
    tools,
    turns: trace.filter((e) => isRecv(e, "transcript.user")).length,
    partials,
    socket,
  };
}
