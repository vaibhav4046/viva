/*
 * §9 of docs/API-FEEDBACK.md: on 12 September an `stt_prompt` beginning
 * "Student:" was seen putting the label into the transcript. The document says
 * that could not be reproduced on 13 September, but nothing in the repo
 * actually ran the re-probe — src/lib/assemblyai.ts, the route and
 * tests/voice-route.test.ts all still assert the leak as probed fact.
 * This is that re-probe. Run: node .viva/probe-stt-prompt-leak.mjs
 *
 * Two clips, three prompts each: none, a prompt thick with speaker labels, and
 * the same prompt with the labels stripped the way condenseContext strips them.
 */
import fs from "node:fs";

function env(p) {
  const o = {};
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    o[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return o;
}
const E = env(".env.local");
const KEY = E.ASSEMBLYAI_API_KEY;
const URL_ = E.ASSEMBLYAI_DICTATION_URL;

function pcmFrom(path) {
  const b = fs.readFileSync(path);
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

const LABELLED =
  "Student: I read about attention this week. Tutor: What stuck? " +
  "Student: The positional encoding part. Tutor: Say more about that. " +
  "Student: I think it's about order.";
// Exactly what src/app/api/voice/transcribe/route.ts condenseContext produces.
const STRIPPED = LABELLED.replace(/(^|\s)(Student|Tutor):\s*/g, "$1").replace(/\s+/g, " ").trim();

const PROMPTS = [
  ["no stt_prompt   ", null],
  ["labelled prompt ", LABELLED],
  ["stripped prompt ", STRIPPED],
];

async function post(pcm, sttPrompt) {
  const config = { sample_rate: 16000, channels: 1, language_codes: ["en"] };
  if (sttPrompt) config.stt_prompt = sttPrompt;
  const form = new FormData();
  form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }), "config.json");
  form.append("audio", new Blob([pcm], { type: "audio/pcm" }), "clip.pcm");
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: KEY }, body: form });
  const body = await r.text();
  try { return { status: r.status, text: JSON.parse(body).text ?? null }; }
  catch { return { status: r.status, text: null, body: body.slice(0, 200) }; }
}

console.log(`labelled prompt: ${JSON.stringify(LABELLED)}`);
console.log(`stripped prompt: ${JSON.stringify(STRIPPED)}\n`);

let anyLeak = false;
for (const clip of ["confusion-16k.wav", "claim-16k.wav"]) {
  const pcm = pcmFrom(`.viva/audio/${clip}`);
  console.log(`${clip} (${(pcm.length / 32000).toFixed(2)} s):`);
  const seen = [];
  for (const [label, prompt] of PROMPTS) {
    const r = await post(pcm, prompt);
    const leaked = /\b(Student|Tutor)\s*:/i.test(r.text ?? "");
    if (leaked) anyLeak = true;
    seen.push(r.text);
    console.log(`  ${label} -> ${r.status} leak:${leaked ? "YES" : "no "} ${JSON.stringify(r.text ?? r.body)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  all three byte-identical: ${seen.every((t) => t === seen[0])}\n`);
}
console.log(`speaker label appeared in any transcript: ${anyLeak ? "YES" : "NO"}`);
