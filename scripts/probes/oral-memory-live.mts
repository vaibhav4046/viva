/**
 * Live probe for two promise clauses against the real AssemblyAI Voice Agent API:
 *
 *   remembered weaknesses: a stored weak concept changes what the next exam opens on
 *   adaptive follow-ups:   the tool result after a checked answer names the next concept and kind
 *
 * Per run, with a fresh browser identity on a local Next server that uses the file
 * store (start it with DATABASE_URL empty and DATA_DIR pointing at a temp folder):
 *
 *   1. GET /api/oral/session on an empty store, record the memory block and greeting.
 *   2. Seed the store through the real tool route: verify_claim on a wrong claim about
 *      multi-head attention (judge returns contradicted) and a right claim about
 *      positional information (supported). The learner map is written by the route.
 *   3. GET /api/oral/session again, record the memory block and greeting.
 *   4. Open a live session with that config. The learner is synthetic (a Windows
 *      System.Speech WAV in fixtures/audio) and says the correct positional claim.
 *   5. Record the greeting the service spoke, the tool result with next_focus, and
 *      the examiner's next spoken turn.
 *
 *   ORAL_PROBE_BASE=http://localhost:3161 npx tsx scripts/probes/oral-memory-live.mts [--runs N]
 *
 * Output: docs/evidence/probes/oral-memory-live.<date>.json
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openOralSocket } from "../../src/lib/oral/socket";

const base = process.env.ORAL_PROBE_BASE ?? "http://localhost:3161";
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const DATE = new Date().toISOString().slice(0, 10);

let cookie = "";
async function request(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) }, cache: "no-store" });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

function pcm(name: string): Buffer {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", root(`fixtures/audio/${name}.wav`), "-ar", "24000", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 16_000_000 });
  if (out.status !== 0) throw new Error(`ffmpeg failed: ${out.stderr.toString().slice(0, 200)}`);
  return out.stdout;
}

async function tool(sessionId: string, name: string, args: Record<string, unknown>, subjectId: string) {
  return (await request("/api/oral/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args, callId: `probe_${Math.random().toString(36).slice(2, 10)}`, subjectId, sessionId }),
  })).result as Record<string, unknown>;
}

type Run = { run: number; ok: boolean; failures: string[]; notes: Record<string, unknown> };

async function once(run: number): Promise<Run> {
  cookie = "";
  const failures: string[] = [];
  const notes: Record<string, unknown> = {};
  try {
    const empty = await request("/api/oral/session");
    notes.before = { memory: empty.memory, greeting: empty.greeting, promptMentionsNoHistory: String(empty.system_prompt).includes("STORED HISTORY: none") };
    if (empty.memory.status !== "empty") failures.push(`fresh identity was not empty: ${empty.memory.status}`);

    const seedSession = `probe_seed_${run}_${Date.now()}`;
    const wrong = await tool(seedSession, "verify_claim", { claim: "I think multi-head attention runs a single head over the input.", concept: "Multi-head attention" }, empty.subjectId);
    await sleep(2500); // a verdict is written after its reply; a real learner is many seconds between answers
    const right = await tool(seedSession, "verify_claim", { claim: "Positional encoding adds information about token order before the first self-attention layer.", concept: "Positional information" }, empty.subjectId);
    notes.seed = { wrong: { verdict: wrong.verdict, page: wrong.page, next_focus: wrong.next_focus }, right: { verdict: right.verdict, page: right.page, next_focus: right.next_focus } };
    if (wrong.verdict !== "contradicted") failures.push(`seed claim was ${String(wrong.verdict)}, not contradicted`);
    await sleep(2500); // the route writes the verdicts after it replies

    const config = await request("/api/oral/session");
    notes.after = { memory: config.memory, greeting: config.greeting, promptVersion: config.promptVersion, promptOpens: /Open the exam with one recall question on ([^.]+)\./.exec(String(config.system_prompt))?.[1] ?? null };
    if (config.memory.status !== "stored") failures.push(`store did not report history after seeding: ${config.memory.status}`);
    if (config.memory.opening !== "Multi-head attention") failures.push(`exam opens on ${String(config.memory.opening)}, not Multi-head attention`);

    // Live session on the seeded map.
    const agent: { text: string; t: number }[] = [];
    const user: string[] = [];
    const toolResults: { name: string; result: Record<string, unknown>; t: number }[] = [];
    let fatal = "";
    let greetingDone = false;
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
        toolResults.push({ name, result: r.result as Record<string, unknown>, t: Date.now() });
        return r.result;
      },
      playAudio: () => {},
      flushAudio: () => {},
      onState: (m) => { if (m.state === "LISTENING" && agent.length > 0) greetingDone = true; if (m.state === "ERROR") fatal = m.reason ?? "unknown"; },
      onTranscript: (text, speaker) => { if (speaker === "agent") agent.push({ text, t: Date.now() }); else user.push(text); },
      onError: (e) => { fatal = e; },
    });
    try {
      const greetBy = Date.now() + 30_000;
      while (!greetingDone && !fatal && Date.now() < greetBy) await sleep(100);
      if (!greetingDone) throw new Error(`greeting incomplete: ${fatal || "timeout"}`);
      const greeting = agent.map((a) => a.text).join(" ");
      notes.spokenGreeting = greeting;
      if (!/multi-head/i.test(greeting)) failures.push("the service did not speak the concept named in the greeting");

      const audio = pcm("student-correct");
      const cut = agent.length;
      for (let i = 0; i < audio.length; i += 4800) {
        const bytes = audio.subarray(i, i + 4800);
        const s = new Int16Array(Math.ceil(bytes.length / 2));
        for (let j = 0; j < s.length; j++) s[j] = bytes.readInt16LE(j * 2);
        socket.sendAudio(s);
        await sleep(100);
      }
      const silence = new Int16Array(2400);
      const end = Date.now() + 75_000;
      let quietSince = Date.now();
      let seen = 0;
      while (Date.now() < end && !fatal) {
        socket.sendAudio(silence);
        await sleep(100);
        const now = agent.length + toolResults.length + user.length;
        if (now !== seen) { seen = now; quietSince = Date.now(); }
        if (toolResults.length > 0 && agent.length > cut + 0 && Date.now() - quietSince > 4000) break;
      }
      const checked = toolResults.find((r) => r.name === "verify_claim" || r.name === "grade_my_answer");
      notes.userHeard = user.join(" | ");
      notes.tools = toolResults.map((r) => ({ name: r.name, verdict: r.result.verdict ?? null, next_focus: r.result.next_focus ?? null }));
      const after = checked ? agent.filter((a) => a.t > checked.t).map((a) => a.text).join(" ") : "";
      notes.examinerAfterCheck = after;
      const focus = checked?.result.next_focus as { concept?: string; kind?: string } | undefined;
      if (!checked) failures.push("no answer-checking tool ran");
      else if (!focus) failures.push("the checked answer returned no next_focus");
      else notes.spokeNextConcept = after.toLowerCase().includes(String(focus.concept).toLowerCase().replace("-", "")) || after.toLowerCase().includes(String(focus.concept).toLowerCase());
    } finally {
      await socket.end();
    }
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  }
  return { run, ok: failures.length === 0, failures, notes };
}

const results: Run[] = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await once(i);
  console.log(`run ${i}: ${r.ok ? "ok" : "FAILED " + r.failures.join("; ")}`);
  results.push(r);
}
const out = {
  probe: "oral-memory-live",
  date: DATE,
  n: RUNS,
  service: "AssemblyAI Voice Agent API (real), local Next server, file store",
  learner: "synthetic voice (Windows System.Speech WAV), no browser, no human microphone",
  transport: "Node WebSocket client running src/lib/oral/socket.ts",
  passed: results.filter((r) => r.ok).length,
  spokeNextConcept: results.filter((r) => r.notes.spokeNextConcept === true).length,
  runs: results,
};
mkdirSync(root("docs/evidence/probes"), { recursive: true });
const file = root(`docs/evidence/probes/oral-memory-live.${DATE}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`wrote ${file}: ${out.passed}/${out.n} passed, examiner spoke the chosen concept in ${out.spokeNextConcept}/${out.n}`);
process.exit(out.passed === out.n ? 0 : 1);
