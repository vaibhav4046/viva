/**
 * LIVE golden-flow check against the real AssemblyAI Voice Agent.
 *
 * This is the one thing the test suite cannot do: prove that the service really
 * sends the events VIVA handles. It runs the same socket client, state machine
 * and controller the browser uses, feeds them two recordings of you speaking,
 * and asserts the outcome the product promises:
 *
 *   1. the session opens and the agent speaks its opening challenge
 *   2. your spoken claim lands in the ledger as CONTRADICTED, with evidence
 *   3. you talk over the agent while it explains: playback is flushed and the
 *      machine goes through INTERRUPTED
 *   4. your correction re-checks the claim and it becomes SUPPORTED
 *
 * It spends real AssemblyAI credit (well under a minute of audio). Never run in CI.
 *
 * Either record two clips yourself (mono PCM16 at 24 kHz):
 *   claim.wav        "We automatically fail over to a replica."
 *   correction.wav   "Wait. I meant manual failover."
 *   ffmpeg -i phone-recording.m4a -ar 24000 -ac 1 -c:a pcm_s16le claim.wav
 *   BASE=http://localhost:3000 npx tsx scripts/live-redteam.mts claim.wav correction.wav
 *
 * or let the Voice Agent make them (no microphone, no TTS install):
 *   BASE=http://localhost:3000 npx tsx scripts/live-redteam.mts --synthesize
 * which opens one short session per sentence with that sentence as the
 * greeting, records the agent's own speech, and uses it as your voice. About
 * ten seconds of agent audio in total.
 *
 * The server must be started with ASSEMBLYAI_API_KEY set:
 *   npm run build && ASSEMBLYAI_API_KEY=... npm start &
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createController, type Api, type Controller } from "../src/lib/redteam/controller";

const BASE = process.env.BASE ?? "http://localhost:3000";

// One plain line on failure, not a stack trace: the person running this wants
// to know which step failed and why, e.g. that the server is not running.
const bail = (e: unknown) => {
  const err = e as { message?: string; cause?: { code?: string } };
  const why = err?.cause?.code === "ECONNREFUSED" ? `nothing is listening at ${BASE} — start the app first` : err?.message ?? String(e);
  console.error(`FAIL  ${why}`);
  process.exit(1);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);
const argv = process.argv.slice(2);
const SYNTH = argv.includes("--synthesize");
const [claimPath, correctionPath] = argv.filter((a) => !a.startsWith("--"));
if (!SYNTH && (!claimPath || !correctionPath)) {
  console.error("usage: BASE=http://localhost:3000 npx tsx scripts/live-redteam.mts claim.wav correction.wav\n   or: BASE=http://localhost:3000 npx tsx scripts/live-redteam.mts --synthesize");
  process.exit(2);
}

/** Minimal WAV reader: mono PCM16 at 24 kHz, or it says why not. */
function readWav(path: string): Int16Array {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path}: not a WAV file`);
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
      bits = b.readUInt16LE(off + 22);
    }
    if (id === "data") {
      if (rate !== 24000 || channels !== 1 || bits !== 16) throw new Error(`${path}: need mono 16-bit 24000 Hz, got ${channels}ch ${bits}-bit ${rate} Hz`);
      const end = Math.min(off + 8 + size, b.length);
      const bytes = b.subarray(off + 8, end - ((end - off - 8) % 2));
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

let cookie = "";
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init?.headers ?? {}) } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !json) throw new Error(`${path} -> ${res.status} ${json?.error?.message ?? ""}`);
  return json;
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

const api: Api = {
  token: async () => (await call<{ token: string }>("/api/voice-agent/token")).token,
  tool: (sessionId, name, args, callId) => post("/api/redteam/tool", { sessionId, name, callId, arguments: args }),
  turn: (sessionId, event, text) => post("/api/redteam/turn", { sessionId, event, ...(text ? { text } : {}) }),
  typed: (sessionId, body) => post("/api/redteam/typed", { sessionId, ...body }),
  end: (sessionId) => post("/api/redteam/end", { sessionId }),
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  console.log(`  (timed out waiting for: ${what})`);
  return false;
}

/** Stream a recording at real time, 100 ms at a time. */
async function speak(ctrl: Controller, pcm: Int16Array): Promise<void> {
  const FRAME = 2400;
  for (let i = 0; i < pcm.length; i += FRAME) {
    const f = new Int16Array(FRAME);
    f.set(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
    ctrl.sendAudio(f);
    await sleep(100);
  }
  for (let i = 0; i < 12; i++) {
    ctrl.sendAudio(new Int16Array(FRAME));
    await sleep(100);
  }
}

/** Write mono PCM16 24 kHz as a WAV file. */
function writeWav(path: string, pcm: Int16Array): void {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

/**
 * Have the Voice Agent say `text` and keep the audio: its greeting is spoken
 * verbatim as soon as the session is ready, so a session whose greeting is the
 * sentence is a text-to-speech call on the same service under test.
 */
async function synthesize(text: string): Promise<Int16Array> {
  const token = await api.token();
  const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`synthesis timed out for "${text}"`)), 30_000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            system_prompt: "You say your greeting and nothing else. Never add words.",
            greeting: text,
            input: { format: { encoding: "audio/pcm" } },
            output: { voice: "alba", format: { encoding: "audio/pcm" } },
          },
        })
      );
    ws.onmessage = (ev) => {
      const m = JSON.parse(String((ev as MessageEvent).data)) as Record<string, unknown>;
      if (m.type === "reply.audio" && typeof m.data === "string") chunks.push(Buffer.from(m.data, "base64"));
      if (m.type === "reply.done") {
        clearTimeout(timer);
        try {
          ws.send(JSON.stringify({ type: "session.end" }));
        } catch {
          // Already closing.
        }
        resolve();
      }
      if (m.type === "session.error") {
        clearTimeout(timer);
        reject(new Error(`synthesis refused: ${String(m.code)} ${String(m.message ?? "")}`));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("synthesis socket failed"));
    };
  });
  try {
    ws.close();
  } catch {
    // Already closed.
  }
  const all = Buffer.concat(chunks);
  return new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength - (all.byteLength % 2)));
}

let claim: Int16Array;
let correction: Int16Array;
if (SYNTH) {
  mkdirSync(".scratch/live", { recursive: true });
  console.log("  synthesising the two utterances with the Voice Agent…");
  claim = await synthesize("We automatically fail over to a replica.");
  correction = await synthesize("Wait. I meant manual failover.");
  writeWav(".scratch/live/claim.wav", claim);
  writeWav(".scratch/live/correction.wav", correction);
  check("synthesised both utterances", claim.length > 12000 && correction.length > 12000, `${(claim.length / 24000).toFixed(1)} s and ${(correction.length / 24000).toFixed(1)} s`);
} else {
  claim = readWav(claimPath);
  correction = readWav(correctionPath);
}

const created = await post<{ session: Parameters<typeof createController>[1]; voice: Parameters<Controller["startVoice"]>[0] }>("/api/redteam/session", { mode: "SKEPTIC", sample: true });
const ctrl = createController(api, created.session);
const seen: string[] = [];
let flushedAt = 0;
let agentBytes = 0;
ctrl.subscribe((s) => {
  const st = s.machine?.state;
  if (st && seen.at(-1) !== st) {
    seen.push(st);
    console.log(`  state: ${st}`);
  }
});
const t0 = Date.now();
ctrl.startVoice(created.voice, {
  playAudio: (b64) => {
    agentBytes += Math.floor((b64.length * 3) / 4);
  },
  flushAudio: () => {
    flushedAt = Date.now();
  },
});

const ready = await until("session.ready", () => ["LISTENING", "SPEAKING"].includes(ctrl.state().machine?.state ?? ""), 20000);
check("session opens on a fresh token (session.ready)", ready, ready ? `${Date.now() - t0} ms` : ctrl.state().error ?? "");
if (!ready) process.exit(1);

const greeted = await until("greeting", () => agentBytes > 0, 20000);
check("the agent speaks its opening challenge", greeted, `${agentBytes} bytes of audio`);
await until("greeting done", () => ctrl.state().machine?.state === "LISTENING", 30000);

console.log("  you: claim.wav");
await speak(ctrl, claim);
const claimed = await until("claim in ledger", () => ctrl.state().session.claims.length > 0, 30000);
check("your spoken claim reached the ledger", claimed, ctrl.state().transcript.filter((l) => l.speaker === "user").map((l) => `"${l.text}"`).join(" | "));
const first = ctrl.state().session.claims[0];
check("the claim is CONTRADICTED with source evidence", first?.status === "CONTRADICTED" && first.contradictionPassageIds.length > 0, first ? `${first.status}: ${first.normalizedClaim}` : "no claim");

const talking = await until("agent explaining", () => ctrl.state().machine?.state === "SPEAKING", 40000);
check("the agent starts explaining the contradiction", talking);
const before = ctrl.state().machine?.interruptions ?? 0;
flushedAt = 0;
const bargeAt = Date.now();
console.log("  you: correction.wav (over the agent)");
const speaking = speak(ctrl, correction);
const cut = await until("barge-in", () => (ctrl.state().machine?.interruptions ?? 0) > before, 15000);
check("barge-in: the service reported the reply interrupted", cut, cut ? `${Date.now() - bargeAt} ms after you started` : "");
check("barge-in: local playback was flushed", flushedAt > 0, flushedAt ? `${flushedAt - bargeAt} ms after you started` : "");
check("barge-in: the machine went through INTERRUPTED", seen.includes("INTERRUPTED"));
await speaking;

const changed = await until("verdict change", () => ctrl.state().session.claims[0]?.status === "SUPPORTED", 40000);
const after = ctrl.state().session.claims[0];
check("the correction re-checked the claim: CONTRADICTED -> SUPPORTED", changed, after ? `${after.status}: ${after.normalizedClaim}` : "");
check("it is the same claim, not a new one", ctrl.state().session.claims.length === 1);

await ctrl.stopVoice();
const report = await api.end(ctrl.state().session.id);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live assertions passed`);
writeFileSync(
  "docs/submission/live-redteam-result.json",
  JSON.stringify(
    { at: new Date().toISOString(), base: BASE, states: seen, transcript: ctrl.state().transcript, timeline: ctrl.state().session.timeline, held: report.report.held.map((h) => h.claim), results },
    null,
    2
  )
);
console.log("wrote docs/submission/live-redteam-result.json");
process.exit(failed.length ? 1 : 0);
