/*
 * Every claim docs/API-FEEDBACK.md makes about the Dictation endpoint, probed
 * directly against it. Run: node .viva/probe-dictation-contract.mjs
 *
 * This goes to the endpoint, not through our app: src/lib/audio/wav.ts refuses
 * non-WAV before the fetch and src/lib/assemblyai.ts only ever appends the
 * parts in the correct order, so the app itself cannot elicit the 400 or the
 * 415 the document quotes. A claim the repo cannot reproduce is not a probe.
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
if (!KEY || !URL_) throw new Error("need ASSEMBLYAI_API_KEY and ASSEMBLYAI_DICTATION_URL in .env.local");

/** WAV data chunk → raw bytes. The endpoint wants headerless PCM. */
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

const PCM = pcmFrom(".viva/audio/confusion-16k.wav");
const CLIP_SECONDS = PCM.length / 32000; // 16 kHz mono s16le
const BASE_CONFIG = { sample_rate: 16000, channels: 1, language_codes: ["en"] };

/** One post. `order` decides which multipart part is appended first. */
async function post({ order = "config-first", audioType = "audio/pcm", auth = KEY, config = BASE_CONFIG, pcm = PCM } = {}) {
  const form = new FormData();
  const cfg = () => form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }), "config.json");
  const aud = () => form.append("audio", new Blob([pcm], { type: audioType }), "clip.bin");
  if (order === "config-first") { cfg(); aud(); } else { aud(); cfg(); }
  const t0 = Date.now();
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: auth }, body: form });
  const body = await r.text();
  return { status: r.status, body, wall: Date.now() - t0 };
}

const show = (r, n = 400) => `${r.status} ${r.body.slice(0, n)}`;
const log = (s) => console.log(s);

log(`clip: .viva/audio/confusion-16k.wav — ${PCM.length} bytes = ${CLIP_SECONDS.toFixed(2)} s of 16 kHz mono s16le\n`);

// ── 1. Does the multipart part order actually matter? ──────────────────────
log("=== 1. multipart part order ===");
const first = await post({ order: "config-first" });
log(`  config first  -> ${first.status}${first.status === 200 ? " (transcript returned)" : " " + first.body.slice(0, 300)}`);
await new Promise((r) => setTimeout(r, 1000));
const second = await post({ order: "audio-first" });
log(`  audio first   -> ${show(second)}`);

// ── 2. What does compressed audio actually return? ─────────────────────────
// Same bytes, only the declared part content type changes.
log("\n=== 2. declared content type on the audio part ===");
for (const ct of ["audio/webm", "audio/mpeg", "audio/wav"]) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await post({ audioType: ct });
  log(`  ${ct.padEnd(11)} -> ${show(r, 300)}`);
}

// ── 3. Bearer prefix. ──────────────────────────────────────────────────────
log("\n=== 3. Authorization header shape ===");
await new Promise((r) => setTimeout(r, 1000));
const bearer = await post({ auth: `Bearer ${KEY}` });
log(`  "Bearer <key>" -> ${show(bearer, 200)}`);
log(`  raw key        -> ${first.status} (run 1 above)`);

// ── 4. keyterms_prompt on this endpoint: does it change the transcript? ────
// Four terms against none, the same clip, twice each, alternating.
log("\n=== 4. keyterms_prompt A/B, same clip ===");
const TERMS = ["positional encoding", "self-attention", "softmax", "queries keys and values"];
const ab = [];
for (let i = 0; i < 2; i++) {
  for (const withTerms of [false, true]) {
    await new Promise((r) => setTimeout(r, 1200));
    const cfg = withTerms ? { ...BASE_CONFIG, keyterms_prompt: TERMS } : BASE_CONFIG;
    const r = await post({ config: cfg });
    let text = null;
    try { text = JSON.parse(r.body).text ?? null; } catch { /* not JSON */ }
    ab.push({ withTerms, text, status: r.status });
    log(`  pass ${i + 1} ${withTerms ? "WITH   " : "WITHOUT"} terms -> ${r.status} ${text === null ? r.body.slice(0, 160) : JSON.stringify(text)}`);
  }
}
const withT = ab.filter((a) => a.withTerms).map((a) => a.text);
const noT = ab.filter((a) => !a.withTerms).map((a) => a.text);
const allSame = [...withT, ...noT].every((t) => t === noT[0]);
log(`  all four byte-identical: ${allSame}`);
if (noT[0]) log(`  word count of the reference clip transcript: ${noT[0].trim().split(/\s+/).length}`);

// ── 5. request_time_ms, straight at the endpoint. ──────────────────────────
const N = Number(process.env.RUNS ?? 12);
log(`\n=== 5. request_time_ms, ${N} runs of the same clip ===`);
const times = [];
for (let i = 0; i < N; i++) {
  await new Promise((r) => setTimeout(r, 800));
  const r = await post();
  let rt = null;
  try { rt = JSON.parse(r.body).request_time_ms ?? null; } catch { /* */ }
  times.push(rt);
  log(`  run ${String(i + 1).padStart(2)}: request_time_ms ${rt} · wall ${r.wall} ms`);
}
const ok = times.filter((t) => typeof t === "number").sort((a, b) => a - b);
if (ok.length) {
  log(`  n=${ok.length}  min ${ok[0]}  median ${ok[Math.floor(ok.length / 2)]}  max ${ok[ok.length - 1]}`);
}

// ── 6. What does `language_codes` actually do on this endpoint? ────────────
// The picker's default is "Automatic", which the streaming socket honours as
// `language_code=multi`. The batch path sends `language_codes`, and nothing
// established what it accepts, what omitting it does, or what non-English
// audio comes back as under each. Needs a clip that is not English: set
// LANG_CLIPS to a comma list of wav paths (default the two under .viva/audio).
log("\n=== 6. language_codes on non-English audio ===");
const LANG_CLIPS = (process.env.LANG_CLIPS ?? ".viva/audio/hindi-16k.wav,.viva/audio/spanish-16k.wav,.viva/audio/confusion-16k.wav")
  .split(",").map((s) => s.trim()).filter(Boolean);
/** What each default clip actually says, so the output can be judged and not
 *  just compared with itself. Synthesised by .viva/synth-lang.mjs. */
const TRUTH = {
  "hindi-16k.wav": "मुझे समझ नहीं आ रहा कि अटेंशन को पोज़िशनल एन्कोडिंग की ज़रूरत क्यों है।",
  "spanish-16k.wav": "No entiendo por qué el mecanismo de atención necesita codificación posicional.",
  "confusion-16k.wav": "(English reference clip)",
};
// `undefined` means the key is left out of the config entirely.
const LANG_CASES = [
  ["omitted", undefined],
  ["[]", []],
  ['["en"]', ["en"]],
  ['["multi"] (the picker default)', ["multi"]],
  ['["hi"]', ["hi"]],
  ['["es"]', ["es"]],
  ['["en","hi"]', ["en", "hi"]],
  ['["pl"] (a picker entry)', ["pl"]],
  ['["uk"] (a picker entry)', ["uk"]],
  ['["zzz"] (bogus — does it enumerate?)', ["zzz"]],
];
for (const clip of LANG_CLIPS) {
  if (!fs.existsSync(clip)) { log(`  ${clip}: not present, skipped`); continue; }
  const clipPcm = pcmFrom(clip);
  const said = TRUTH[clip.split(/[\\/]/).pop()];
  log(`\n  ${clip} — ${(clipPcm.length / 32000).toFixed(2)} s${said ? `\n    said: ${said}` : ""}`);
  for (const [label, codes] of LANG_CASES) {
    await new Promise((r) => setTimeout(r, 1200));
    const config = { sample_rate: 16000, channels: 1 };
    if (codes !== undefined) config.language_codes = codes;
    const r = await post({ config, pcm: clipPcm });
    // A refusal is printed WHOLE: its detail is the endpoint's own enumeration
    // of what it accepts, which is the only place that list is written down.
    let out = r.body;
    try {
      const j = JSON.parse(r.body);
      if (typeof j.text === "string") out = JSON.stringify(j.text);
    } catch { /* not JSON */ }
    log(`    ${label.padEnd(32)} -> ${r.status} ${out}`);
  }
}
