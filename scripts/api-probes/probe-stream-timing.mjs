/*
 * §2 and §3 of docs/API-FEEDBACK.md, measured at the socket rather than at the
 * DOM. Run: node .viva/probe-stream-timing.mjs
 *
 * .viva/stream-latency.mjs polls the browser DOM every 60 ms and measures from
 * mic-open, so it can resolve neither a single millisecond nor "behind the
 * voice". This streams the clip in real time and timestamps the frames as they
 * arrive, so every number below is:
 *
 *   lag  = when the first partial arrived, minus when the audio carrying the
 *          first word had been sent. Speech onset is found in the WAV itself
 *          (first sample over the noise floor), so this really is "behind the
 *          voice", with the resolution of one frame.
 *   gap  = wall time between consecutive Turn frames whose transcript changed.
 *   turns = Turn frames with end_of_turn true (the empty flush is excluded and
 *          counted separately).
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
const KEY = env(".env.local").ASSEMBLYAI_API_KEY;
const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * First 20 ms window that is clearly speech.
 *
 * The threshold is a fraction of the LOUDEST window in the clip, not of a
 * leading "noise floor". An earlier version of this took the floor from the
 * first 200 ms — but this clip starts speaking at ~100 ms, so that window
 * already contained speech, the floor came out at rms 1675, the 8x threshold
 * (13401) was above the clip's loudest window (7005), no window ever crossed
 * it, and the function silently returned 0. A detector that reports "0 ms"
 * both for "starts immediately" and for "found nothing" is worse than none.
 */
function speechOnsetMs(pcm) {
  const WIN = 320; // 20 ms at 16 kHz
  const rms = [];
  for (let i = 0; i + WIN * 2 <= pcm.length; i += WIN * 2) {
    let s = 0;
    for (let j = 0; j < WIN; j++) { const v = pcm.readInt16LE(i + j * 2); s += v * v; }
    rms.push(Math.sqrt(s / WIN));
  }
  const peak = Math.max(...rms);
  const thresh = peak * 0.15;
  const idx = rms.findIndex((r) => r > thresh);
  if (idx < 0) throw new Error(`no speech found (peak rms ${Math.round(peak)}) — check the clip`);
  return { onsetMs: idx * 20, peak: Math.round(peak), thresh: Math.round(thresh) };
}
const ONSET = speechOnsetMs(PCM);

async function token(seconds = 180) {
  const r = await fetch(`https://streaming.assemblyai.com/v3/token?expires_in_seconds=${seconds}`, {
    headers: { Authorization: KEY },
  });
  return (await r.json()).token;
}

/**
 * Stream the clip in real time.
 * terminate: "after"  — send Terminate once the audio has drained and settled
 *            "midturn"— send Terminate while words are still arriving
 */
async function run({ language_code, frameMs = 100, terminate = "after", quiet = false }) {
  const q = new URLSearchParams({
    token: await token(), encoding: "pcm_s16le", sample_rate: "16000",
    format_turns: "true", language_code,
  });
  const ws = new WebSocket("wss://streaming.assemblyai.com/v3/ws?" + q);
  const ev = [];
  let model = null;
  let t0 = null;                 // when the first audio frame went out
  let sentMs = 0;                // audio milliseconds sent so far
  const afterTerminate = [];
  let terminateAt = null;

  await new Promise((resolve) => {
    const bail = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(); }, 90000);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      const at = Date.now();
      if (msg.type === "Begin") model = msg.configuration?.model ?? null;
      if (msg.type === "Turn") {
        const rec = {
          at, sentMs,
          transcript: msg.transcript ?? "",
          end_of_turn: !!msg.end_of_turn,
          words: (msg.words ?? []).length,
          finalWords: (msg.words ?? []).filter((w) => w.word_is_final).length,
        };
        ev.push(rec);
        if (terminateAt) afterTerminate.push(rec);
      }
      if (msg.type === "Termination") { clearTimeout(bail); resolve(); }
      if (msg.type === "Error") { if (!quiet) log(`    ERROR ${msg.error_code} ${msg.error}`); clearTimeout(bail); resolve(); }
    };
    ws.onclose = () => { clearTimeout(bail); resolve(); };
    ws.onerror = () => { clearTimeout(bail); resolve(); };
    ws.onopen = async () => {
      const bytes = frameMs * 32;   // 16 kHz mono s16le = 32 bytes per ms
      t0 = Date.now();
      for (let i = 0; i < PCM.length; i += bytes) {
        // Mid-turn means: cut it off while the model is still mid-utterance.
        if (terminate === "midturn" && sentMs >= 3000) break;
        ws.send(PCM.subarray(i, i + bytes));
        sentMs += frameMs;
        await sleep(frameMs);
      }
      if (terminate === "after") await sleep(2500);
      terminateAt = Date.now();
      ws.send(JSON.stringify({ type: "Terminate" }));
    };
  });

  // First frame carrying any text, relative to the moment the voice began.
  const first = ev.find((e) => e.transcript);
  const lag = first ? (first.at - t0) - ONSET.onsetMs : null;
  const changed = ev.filter((e, i) => e.transcript && (i === 0 || e.transcript !== ev[i - 1].transcript));
  const gaps = changed.slice(1).map((e, i) => e.at - changed[i].at).sort((a, b) => a - b);
  const finals = ev.filter((e) => e.end_of_turn);

  // Walk turn by turn. For each turn: how many of its words had already been
  // marked word_is_final BEFORE the frame that closed it, and how many words
  // the turn ended up with. Summing both across turns is the clip-level
  // "N of the clip's M words settled before their turn closed".
  let settledInClip = 0;
  let wordsInClip = 0;
  let bestThisTurn = 0;
  let sawText = false;
  for (const e of ev) {
    if (e.end_of_turn) {
      if (e.words > 0) { settledInClip += Math.min(bestThisTurn, e.words); wordsInClip += e.words; }
      bestThisTurn = 0; sawText = false;
      continue;
    }
    if (e.transcript) sawText = true;
    if (sawText) bestThisTurn = Math.max(bestThisTurn, e.finalWords);
  }

  return {
    model, lag, gaps, changed: changed.length, ev,
    turns: finals.filter((f) => f.transcript).length,
    emptyFinals: finals.filter((f) => !f.transcript).length,
    afterTerminate,
    settledInClip, wordsInClip,
    text: finals.filter((f) => f.transcript).map((f) => f.transcript).join(" "),
  };
}

log(`clip 9.55 s · speech onset ${ONSET.onsetMs} ms into the file (peak window rms ${ONSET.peak}, threshold ${ONSET.thresh})\n`);

// ── §2 ─────────────────────────────────────────────────────────────────────
log("=== §2 lag, cadence, settle and turn count ===");
const RUNS = Number(process.env.RUNS ?? 3);
for (const language_code of ["en", "multi"]) {
  for (const frameMs of [100, 50]) {
    for (let i = 0; i < RUNS; i++) {
      const r = await run({ language_code, frameMs });
      const med = r.gaps.length ? r.gaps[Math.floor(r.gaps.length / 2)] : null;
      log(
        `  ${language_code.padEnd(5)} ${String(frameMs).padStart(3)}ms frames run ${i + 1}: model ${r.model}` +
        ` · first partial ${r.lag} ms behind the voice` +
        ` · ${r.changed} updates, gaps ${r.gaps[0] ?? "-"}-${r.gaps[r.gaps.length - 1] ?? "-"} ms (median ${med})` +
        ` · ${r.turns} turns` +
        ` · settled before their turn closed: ${r.settledInClip}/${r.wordsInClip} words`
      );
      if (i === 0) log(`        transcript (${r.wordsInClip} words): ${JSON.stringify(r.text)}`);
      await sleep(3000);
    }
  }
}

// ── §3 ─────────────────────────────────────────────────────────────────────
log("\n=== §3 what arrives after Terminate ===");
for (const language_code of ["en", "multi"]) {
  for (const terminate of ["after", "midturn"]) {
    const r = await run({ language_code, terminate });
    const desc = r.afterTerminate.length === 0
      ? "none"
      : r.afterTerminate.map((f) => `{end_of_turn:${f.end_of_turn}, transcript:${JSON.stringify(f.transcript.slice(0, 48))}, words:${f.words}}`).join("  ");
    log(`  ${(r.model ?? language_code).padEnd(32)} Terminate ${terminate.padEnd(8)} -> ${r.afterTerminate.length} Turn frame(s) after it: ${desc}`);
    await sleep(3000);
  }
}
