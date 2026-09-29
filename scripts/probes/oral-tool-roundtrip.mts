/** Real AssemblyAI Voice Agent probe. The learner voice is synthetic. Run with
 * `npx tsx scripts/probes/oral-tool-roundtrip.mts` against a local Next server. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openOralSocket } from "../../src/lib/oral/socket";

const base = process.env.ORAL_PROBE_BASE ?? "http://localhost:3199";
const audio = fileURLToPath(new URL("../../fixtures/audio/student-misconception.wav", import.meta.url));
const t0 = Date.now();
const ms = () => Date.now() - t0;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const log = (...parts: unknown[]) => console.log(`[${ms()}ms]`, ...parts);

let cookie = "";
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) }, cache: "no-store" });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const config = await request("/api/oral/session");
const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", audio, "-ar", "24000", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 8_000_000 });
if (pcm.status !== 0) throw new Error(`ffmpeg failed: ${pcm.stderr.toString().slice(0, 200)}`);
log("synthetic learner audio ready", { bytes: pcm.stdout.length, subject: config.subjectId });

let ready = false;
let greetingDone = false;
let userText = "";
let agentText = "";
let toolCalls = 0;
let toolResults = 0;
let sourceChecks: unknown[] = [];
let fatal = "";
let lastEventAt = Date.now();
const states: string[] = [];

const socket = openOralSocket({
  config,
  subjectId: config.subjectId,
  getToken: async () => String((await request("/api/voice-agent/token")).token),
  runTool: async (name, args, callId) => {
    toolCalls++;
    lastEventAt = Date.now();
    log("tool.call", name, callId, JSON.stringify(args).slice(0, 100));
    const response = await request("/api/oral/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args, callId, subjectId: config.subjectId, sessionId: socket.machine().sessionId }),
    });
    sourceChecks.push({ name, result: response.result });
    lastEventAt = Date.now();
    log("tool HTTP complete", name, `isError=${response.isError}`);
    return response.result;
  },
  openSocket: (url) => {
    const ws = new WebSocket(url);
    const send = ws.send.bind(ws);
    ws.send = ((data: string) => {
      const message = JSON.parse(data);
      if (message.type === "tool.result") { toolResults++; lastEventAt = Date.now(); log("tool.result sent", message.call_id); }
      return send(data);
    }) as typeof ws.send;
    return ws as unknown as WebSocket;
  },
  playAudio: () => {},
  flushAudio: () => log("audio flush"),
  onState: (m) => {
    if (states.at(-1) !== m.state) { states.push(m.state); log("state", m.state); }
    if (m.state === "LISTENING" && agentText) greetingDone = true;
    if (m.state === "ERROR") fatal = m.reason ?? "unknown";
  },
  onTranscript: (text, speaker) => {
    lastEventAt = Date.now();
    log("transcript", speaker, JSON.stringify(text.slice(0, 160)));
    if (speaker === "user") userText += text;
    else agentText += `${text} `;
  },
  onError: (error) => { fatal = error; log("error", error); },
});

try {
  const greetingDeadline = Date.now() + 30000;
  while (!greetingDone && Date.now() < greetingDeadline && !fatal) await sleep(100);
  if (!greetingDone) throw new Error(`greeting incomplete: ${fatal || "timeout"}`);
  log("greeting completed; sending synthetic learner voice");
  const frameBytes = 4800;
  for (let i = 0; i < pcm.stdout.length; i += frameBytes) {
    const bytes = pcm.stdout.subarray(i, i + frameBytes);
    const samples = new Int16Array(Math.ceil(bytes.length / 2));
    for (let j = 0; j < samples.length; j++) samples[j] = bytes.readInt16LE(j * 2);
    socket.sendAudio(samples);
    await sleep(100);
  }
  const silence = new Int16Array(2400);
  for (let i = 0; i < 25; i++) { socket.sendAudio(silence); await sleep(100); }
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline && !fatal && (!userText || toolCalls === 0 || toolResults < toolCalls || Date.now() - lastEventAt < 3500)) await sleep(200);
  log("RESULT", JSON.stringify({ userText, agentText, toolCalls, toolResults, states, fatal, sourceChecks }));
  if (!userText || toolCalls === 0 || toolResults === 0) throw new Error("live round trip incomplete");
} finally {
  await socket.end();
}
