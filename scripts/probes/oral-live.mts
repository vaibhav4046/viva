/**
 * Live probes against the real AssemblyAI Voice Agent API, driven through the
 * real client socket (src/lib/oral/socket.ts) and the real /api/oral routes of a
 * running Next server. The learner is synthetic: Windows System.Speech WAVs in
 * fixtures/audio, streamed to the socket in real time. Nothing is mocked except
 * the speaker (there is none in Node), so stop latency here is the time to the
 * client's flush call; the browser probe measures the AudioContext stop.
 *
 *   ORAL_PROBE_BASE=http://localhost:3101 npx tsx scripts/probes/oral-live.mts roundtrip|bargein|bargein_tool|resume [--runs N]
 *
 * Output: docs/evidence/probes/oral-live-<scenario>.<date>.json. Then run scripts/probes/oral-compact-evidence.mjs (shrinks raw audio rows) and scripts/probes/oral-numbers.mjs (refreshes numbers.json).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openOralSocket, type OralTraceEvent } from "../../src/lib/oral/socket";

// The resume probe needs a socket it can kill without a close frame; Next ships one.
const WsLib = createRequire(import.meta.url)("next/dist/compiled/ws") as { WebSocket: new (url: string) => unknown };
const base = process.env.ORAL_PROBE_BASE ?? "http://localhost:3101";
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const scenario = process.argv[2] ?? "roundtrip";
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : scenario === "resume" ? 2 : 3;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const FRAME = 2400;
const DATE = new Date().toISOString().slice(0, 10);

function wavToPcm(name: string): Int16Array {
  const wav = root(`fixtures/audio/${name}.wav`);
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", wav, "-ar", "24000", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 16_000_000 });
  if (out.status !== 0) throw new Error(`ffmpeg failed: ${out.stderr.toString().slice(0, 200)}`);
  const b = out.stdout;
  const s = new Int16Array(Math.floor(b.length / 2));
  for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(i * 2);
  return s;
}
const voiceOnsetSamples = (pcm: Int16Array) => { const i = pcm.findIndex((v) => Math.abs(v) > 800); return i < 0 ? 0 : i; };

let cookie = "";
async function request(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) }, cache: "no-store" });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

type Trace = OralTraceEvent[] & { dropSocket?: () => void };
type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function makeHarness() {
  const trace: Trace = [];
  (globalThis as { __VIVA_ORAL_TRACE__?: Trace }).__VIVA_ORAL_TRACE__ = trace;
  const mark = (kind: string, fields: Record<string, unknown> = {}) => trace.push({ t: performance.now(), kind, ...fields });
  const config = await request("/api/oral/session");
  const agent: { text: string; interrupted: boolean; t: number }[] = [];
  const user: { text: string; t: number }[] = [];
  const toolResults: { name: string; args: unknown; result: Record<string, unknown> }[] = [];
  let fatal = "";
  let queue: Int16Array[] = [];
  let pumping = true;

  const socket = openOralSocket({
    config,
    subjectId: config.subjectId,
    getToken: async () => String((await request("/api/voice-agent/token")).token),
    runTool: async (name, args, callId) => {
      const r = await request("/api/oral/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args, callId, subjectId: config.subjectId, sessionId: socket.machine().sessionId }),
      });
      toolResults.push({ name, args, result: r.result as Record<string, unknown> });
      return r.result;
    },
    ...(scenario === "resume" ? { openSocket: (url: string) => new WsLib.WebSocket(url) as unknown as WebSocket } : {}),
    playAudio: () => {},
    flushAudio: () => {},
    onState: () => {},
    onTranscript: (text, speaker, interrupted) => {
      if (speaker === "agent") agent.push({ text, interrupted: !!interrupted, t: performance.now() });
      else user.push({ text, t: performance.now() });
    },
    // "Expired ... Starting a new one" is the designed notice for a refused resume, not a failure of the probe.
    onError: (e) => { if (/expired/i.test(e)) mark("probe.notice", { text: e }); else fatal = e; },
  });

  // The mic: real-time 100 ms frames, silence unless a clip is queued.
  const silence = new Int16Array(FRAME);
  void (async () => {
    const t0 = performance.now();
    for (let n = 1; pumping; n++) {
      socket.sendAudio(queue.shift() ?? silence);
      const wait = t0 + n * 100 - performance.now();
      if (wait > 0) await sleep(wait);
    }
  })();

  const say = (pcm: Int16Array) => {
    mark("probe.clip.start", { voiceOnsetMs: Math.round((voiceOnsetSamples(pcm) / 24000) * 1000) });
    for (let i = 0; i < pcm.length; i += FRAME) {
      const f = new Int16Array(FRAME);
      f.set(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
      queue.push(f);
    }
  };
  const waitFor = async (what: string, pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (fatal) throw new Error(`fatal while waiting for ${what}: ${fatal}`);
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
      await sleep(40);
    }
  };
  const seen = (kind: string, pick: Record<string, unknown> = {}, after = 0) =>
    trace.find((e) => e.t > after && e.kind === kind && Object.entries(pick).every(([k, v]) => e[k] === v));
  const stop = async () => { pumping = false; await socket.end(); };
  return { trace, socket, agent, user, toolResults, say, waitFor, seen, mark, stop, fatal: () => fatal, clipQueueLength: () => queue.length };
}

const round = (n: number) => Math.round(n);
type RunOut = { run: number; ok: boolean; failures: string[]; metrics: Record<string, number>; notes: Record<string, unknown> };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
function pagesSpoken(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/page\s+([a-z0-9-]+)/gi)) {
    const w = m[1].toLowerCase();
    const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    if (n) out.push(n);
  }
  return out;
}

async function greeted(h: Harness) {
  await h.waitFor("greeting reply.done", () => !!h.seen("ws.recv", { type: "reply.done" }), 30_000);
  await sleep(300);
}

async function runRoundtrip(run: number): Promise<RunOut> {
  const h = await makeHarness();
  const failures: string[] = [];
  const metrics: Record<string, number> = {};
  const notes: Record<string, unknown> = {};
  try {
    await h.waitFor("ws.connect", () => !!h.seen("ws.connect"), 15_000);
    const connect = h.seen("ws.connect")!.t;
    await greeted(h);
    metrics.sessionReadyMs = round(h.seen("ws.recv", { type: "session.ready" })!.t - connect);
    metrics.firstAudioMs = round(h.seen("audio.play")!.t - connect);
    const greetingDoneAt = h.seen("ws.recv", { type: "reply.done" })!.t;
    notes.greetingSpeechMs = round(greetingDoneAt - h.seen("audio.play")!.t);
    h.say(wavToPcm("student-misconception"));
    await sleep(2500);
    await h.waitFor("tool.result sent", () => !!h.seen("tool.result.send"), 60_000);
    const sent = h.seen("tool.result.send")!;
    const call = h.trace.find((e) => e.kind === "ws.recv" && e.type === "tool.call")!;
    const start = h.seen("tool.http.start")!;
    const end = h.seen("tool.http.end")!;
    metrics.toolCallToResultMs = round(sent.t - call.t);
    metrics.toolHttpMs = round(end.t - start.t);
    // Rule from the events reference: tool.result goes out only when reply.done is the latest event received.
    const before = h.trace.filter((e) => e.t < sent.t && e.kind === "ws.recv");
    if (before.at(-1)?.type !== "reply.done") failures.push(`tool.result sent while latest received event was ${String(before.at(-1)?.type)}`);
    await h.waitFor("spoken reply after the tool result", () => h.agent.filter((a) => a.t > sent.t).length > 0 && !!h.seen("ws.recv", { type: "reply.done" }, sent.t), 45_000);
    await sleep(800);
    const tr = h.toolResults.find((r) => r.name === "verify_claim");
    notes.verifyClaim = tr ? { verdict: tr.result.verdict, page: tr.result.page, method: tr.result.method, quote: tr.result.quote, latency_ms: tr.result.latency_ms, args: tr.args } : null;
    const spoken = h.agent.filter((a) => a.t > sent.t).map((a) => a.text).join(" ");
    notes.agentAfterTool = spoken;
    notes.userHeard = h.user.map((u) => u.text).join(" | ");
    if (!tr) failures.push("verify_claim was never run");
    else if (tr.result.verdict === "contradicted") {
      const pages = pagesSpoken(spoken);
      notes.pagesSpoken = pages;
      if (!pages.includes(Number(tr.result.page))) failures.push(`spoken correction did not cite page ${String(tr.result.page)}`);
    } else {
      failures.push(`verdict was ${String(tr.result.verdict)}, not contradicted, so no spoken correction was required`);
    }
    const states = h.trace.filter((e) => e.kind === "state").map((e) => String(e.state));
    notes.states = states;
    const i = states.indexOf("CHECKING_SOURCE");
    if (i < 0 || !states.slice(i).includes("SPEAKING")) failures.push("state trace lacks CHECKING_SOURCE then SPEAKING");
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  } finally {
    notes.trace = h.trace.map(({ t, kind, ...rest }) => ({ ms: Math.round(t), kind, ...rest }));
    await h.stop();
  }
  return { run, ok: failures.length === 0, failures, metrics, notes };
}

async function runBargeIn(run: number, viaTool = false): Promise<RunOut> {
  const h = await makeHarness();
  const failures: string[] = [];
  const metrics: Record<string, number> = {};
  const notes: Record<string, unknown> = {};
  try {
    if (!viaTool) {
      // The greeting is the agent's long sentence: barge in while it is audible.
      await h.waitFor("agent speech", () => !!h.seen("audio.play"), 30_000);
      await sleep(900);
    } else {
      // Live finding: speech sent while a tool call is pending (execution_mode hold) is not detected at
      // all, so there is nothing to interrupt in that window. The correction spoken after the
      // result is the long sentence of this flow, so barge in 1.2 s into it.
      await greeted(h);
      h.say(wavToPcm("student-misconception"));
      await h.waitFor("tool.result.send", () => !!h.seen("tool.result.send"), 60_000);
      await sleep(1200);
    }
    const clipAt = performance.now();
    h.say(wavToPcm("student-interruption"));
    const onset = Number((h.trace.find((e) => e.kind === "probe.clip.start" && e.t >= clipAt - 5)?.voiceOnsetMs) ?? 0);
    const voiceAt = clipAt + onset;
    await h.waitFor("input.speech.started", () => !!h.seen("ws.recv", { type: "input.speech.started" }, clipAt), 20_000);
    const started = h.seen("ws.recv", { type: "input.speech.started" }, clipAt)!;
    await h.waitFor("interrupted reply.done", () => !!h.seen("ws.recv", { type: "reply.done", status: "interrupted" }, clipAt), 20_000).catch(() => {});
    const flushEnd = h.seen("barge_in.flush.end", {}, clipAt);
    const interrupted = h.seen("ws.recv", { type: "reply.done", status: "interrupted" }, clipAt);
    metrics.speechDetectedMs = round(started.t - voiceAt);
    if (flushEnd) {
      metrics.flushAfterSpeechStartedMs = round(flushEnd.t - started.t);
      metrics.stopFromVoiceOnsetMs = round(flushEnd.t - voiceAt);
    } else failures.push("no barge_in.flush: the agent was not SPEAKING when input.speech.started arrived");
    if (!interrupted) failures.push("no reply.done with status interrupted");
    else metrics.interruptedReplyDoneMs = round(interrupted.t - voiceAt);
    // Stale audio: chunks of the interrupted reply that arrived after the flush.
    metrics.staleAudioChunksPlayedAfterFlush = flushEnd && interrupted ? h.trace.filter((e) => e.kind === "audio.play" && e.t > flushEnd.t && e.t < interrupted.t).length : -1;
    metrics.staleAudioChunksDroppedAfterFlush = flushEnd && interrupted ? h.trace.filter((e) => e.kind === "audio.drop" && e.t > flushEnd.t && e.t < interrupted.t).length : -1;
    // The service does not always send a final transcript.agent for a completed reply, so a finished reply.done counts.
    await h.waitFor("agent answer to the interruption", () => !!h.seen("ws.recv", { type: "reply.done", status: "completed" }, interrupted?.t ?? clipAt), 45_000).catch((e) => failures.push(`no agent reply after the interruption (${e instanceof Error ? e.message : e})`));
    notes.agent = h.agent.map((a) => ({ text: a.text, interrupted: a.interrupted }));
    notes.user = h.user.map((u) => u.text);
    const states = h.trace.filter((e) => e.kind === "state").map((e) => String(e.state));
    notes.states = states;
    const m = h.socket.machine();
    notes.machine = { interruptions: m.interruptions, discards: m.discards, toolCalls: m.toolCalls };
    if (!states.includes("INTERRUPTED")) failures.push("state trace lacks INTERRUPTED");
    if (viaTool) {
      const sends = h.trace.filter((e) => e.kind === "tool.result.send");
      notes.toolResultsSent = sends.length;
      // Nothing may be delivered after the interruption for a call that finished before it.
      const late = sends.filter((e) => interrupted && e.t > interrupted.t);
      if (late.length) failures.push("a tool.result was sent after the interrupted reply.done");
    }
    if (!h.agent.some((a) => a.interrupted) && !viaTool) failures.push("no transcript.agent with interrupted=true");
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  } finally {
    notes.trace = h.trace.map(({ t, kind, ...rest }) => ({ ms: Math.round(t), kind, ...rest }));
    await h.stop();
  }
  return { run, ok: failures.length === 0, failures, metrics, notes };
}

async function runResume(run: number): Promise<RunOut> {
  const h = await makeHarness();
  const failures: string[] = [];
  const metrics: Record<string, number> = {};
  const notes: Record<string, unknown> = {};
  const deltasBetween = (from: number, to = Infinity) => h.trace.filter((e) => e.type === "transcript.agent.delta" && e.t > from && e.t < to).map((e) => String(e.delta ?? "")).join(" ").replace(/s+/g, " ").trim();
  try {
    await greeted(h);
    // One real exchange first, so there is context worth keeping.
    h.say(wavToPcm("student-correct"));
    await sleep(2500);
    await h.waitFor("first answer graded", () => h.user.length > 0 && !!h.seen("ws.recv", { type: "reply.done" }, h.user.at(-1)!.t), 60_000);
    await sleep(500);
    const idBefore = h.socket.machine().sessionId;
    const dropAt = performance.now();
    h.trace.dropSocket?.();
    await h.waitFor("RECOVERING", () => !!h.seen("state", { state: "RECOVERING" }, dropAt), 5_000);
    await h.waitFor("session.ready after the drop", () => !!h.trace.find((e) => e.kind === "ws.recv" && e.type === "session.ready" && e.t > dropAt), 40_000);
    const readyAt = h.trace.find((e) => e.kind === "ws.recv" && e.type === "session.ready" && e.t > dropAt)!.t;
    metrics.recoveryMs = round(readyAt - dropAt);
    const refused = h.trace.find((e) => e.type === "session.error" && e.t > dropAt);
    const modes = h.trace.filter((e) => e.kind === "ws.connect" && e.t > dropAt).map((e) => String(e.mode));
    const carried = h.trace.find((e) => e.kind === "session.update.sent" && e.t > dropAt);
    notes.connectModesAfterDrop = modes;
    notes.resumeRefusedWith = refused ? refused.code : null;
    notes.outcome = refused ? "resume refused by the service, continued in a new session with the recent turns" : "resumed";
    notes.sessionIdChanged = idBefore !== h.socket.machine().sessionId;
    if (modes.filter((m) => m === "resume").length > 3) failures.push("more than 3 resume attempts");
    if (refused && !(carried && carried.continued === true && Number(carried.historyTurns) >= 1)) failures.push("refused resume but the new session did not carry the turns");
    if (!refused && notes.sessionIdChanged) failures.push("resume reported success but the session id changed");
    // The new session speaks its own short line, not the opening greeting.
    await sleep(5000);
    notes.sayingAfterRecovery = deltasBetween(readyAt);
    if (/being examined/i.test(String(notes.sayingAfterRecovery))) failures.push("the opening greeting was repeated after recovery");
    // Coherence: ask for the question again; a session that kept context answers about the exam.
    const before = performance.now();
    h.say(wavToPcm("student-interruption"));
    await sleep(2500);
    await h.waitFor("reply after recovery", () => !!h.seen("ws.recv", { type: "reply.done", status: "completed" }, before), 45_000);
    await sleep(500);
    notes.replyToRepeatRequest = deltasBetween(before);
    notes.userTurnsHeard = h.user.map((u) => u.text);
    notes.states = h.trace.filter((e) => e.kind === "state").map((e) => String(e.state));
    if (!h.user.some((u) => /repeat/i.test(u.text))) failures.push("the post-recovery student turn was not transcribed");
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  } finally {
    notes.trace = h.trace.filter((e) => e.kind !== "audio.play" && e.type !== "reply.audio").map(({ t, kind, ...rest }) => ({ ms: Math.round(t), kind, ...rest }));
    await h.stop();
  }
  return { run, ok: failures.length === 0, failures, metrics, notes };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };

const results: RunOut[] = [];
for (let i = 1; i <= runs; i++) {
  console.log(`--- ${scenario} run ${i}/${runs}`);
  const r = scenario === "roundtrip" ? await runRoundtrip(i) : scenario === "bargein" ? await runBargeIn(i) : scenario === "bargein_tool" ? await runBargeIn(i, true) : await runResume(i);
  console.log(r.ok ? "PASS" : "FAIL", JSON.stringify(r.metrics), r.failures.join("; "));
  results.push(r);
  await sleep(2000);
}

const names = [...new Set(results.flatMap((r) => Object.keys(r.metrics)))];
const summary = Object.fromEntries(names.map((n) => {
  const vals = results.filter((r) => n in r.metrics && r.metrics[n] >= 0).map((r) => r.metrics[n]);
  return [n, { median: median(vals), n: vals.length, values: vals }];
}));
const evidencePath = `docs/evidence/probes/oral-live-${scenario}.${DATE}.json`;
mkdirSync(root("docs/evidence/probes"), { recursive: true });
const out = {
  measuredOn: new Date().toISOString(),
  scenario,
  learner: "synthetic (Windows System.Speech WAVs in fixtures/audio)",
  transport: "Node WebSocket through src/lib/oral/socket.ts against the live AssemblyAI Voice Agent API",
  cmd: `ORAL_PROBE_BASE=${base} npx tsx scripts/probes/oral-live.mts ${scenario} --runs ${runs}`,
  runs: results.length,
  passed: results.filter((r) => r.ok).length,
  summary,
  results,
};
writeFileSync(root(evidencePath), JSON.stringify(out, null, 2), "utf8");

console.log("SUMMARY", JSON.stringify(summary), `passed ${out.passed}/${out.runs}`, "->", evidencePath);
process.exit(out.passed === out.runs ? 0 : 1);
