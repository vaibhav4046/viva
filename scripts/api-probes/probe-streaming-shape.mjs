/*
 * The streaming socket's shape claims in docs/API-FEEDBACK.md:
 *   §1  does `en,hi` really close the socket?
 *   §4  what is actually in the `Begin` payload, on both models?
 *   §5  ten PARALLEL opens — how many get Begin, how many get 1008?
 * Run: node .viva/probe-streaming-shape.mjs
 *
 * .viva/api-feedback-probe.mjs opens sockets strictly in sequence with a
 * 1400 ms sleep, so it cannot produce a concurrency split. This one does the
 * opens in one Promise.all, which is the only way to actually hit the cap.
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

async function token(seconds = 120) {
  const r = await fetch(`https://streaming.assemblyai.com/v3/token?expires_in_seconds=${seconds}`, {
    headers: { Authorization: KEY },
  });
  return (await r.json()).token;
}

/** Open one socket, capture the first Begin or the closing Error, then go. */
function open(params, { hold = 0 } = {}) {
  return new Promise(async (resolve) => {
    const q = new URLSearchParams({ token: await token(), encoding: "pcm_s16le", sample_rate: "16000", ...params });
    const ws = new WebSocket("wss://streaming.assemblyai.com/v3/ws?" + q);
    let begin = null;
    let err = null;
    const done = (r) => { clearTimeout(to); try { ws.close(); } catch { /* */ } resolve(r); };
    const to = setTimeout(() => done({ result: "timeout" }), 15000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "Begin") {
        begin = m;
        if (hold) setTimeout(() => done({ result: "begin", begin }), hold);
        else done({ result: "begin", begin });
      }
      if (m.type === "Error") err = m;
    };
    ws.onclose = (e) => { clearTimeout(to); resolve({ result: begin ? "begin" : "closed", begin, closeCode: e.code, error: err }); };
    ws.onerror = () => {};
  });
}

// ── 1. Language codes the document names. One socket each, in sequence. ────
log("=== 1. language_code, one socket each ===");
for (const code of ["en", "hi", "multi", "en,hi", "pl", "uk"]) {
  const r = await open({ language_code: code });
  if (r.result === "begin") log(`  ${code.padEnd(6)} -> Begin, model ${r.begin.configuration?.model}`);
  else log(`  ${code.padEnd(6)} -> ${r.result} close ${r.closeCode} ${r.error ? JSON.stringify({ error_code: r.error.error_code, error: r.error.error }) : ""}`);
  await new Promise((r) => setTimeout(r, 1500));
}

// ── 2. The whole Begin frame, verbatim, on both models. ────────────────────
log("\n=== 2. the complete Begin payload ===");
for (const code of ["en", "multi"]) {
  const r = await open({ language_code: code });
  log(`  language_code=${code}:`);
  log("    " + JSON.stringify(r.begin, null, 2).split("\n").join("\n    "));
  log(`    top-level keys: ${Object.keys(r.begin ?? {}).join(", ")}`);
  log(`    configuration keys: ${Object.keys(r.begin?.configuration ?? {}).join(", ")}`);
  await new Promise((r) => setTimeout(r, 1500));
}

// ── 3. Does Begin echo keyterms_prompt? ────────────────────────────────────
log("\n=== 3. does Begin echo keyterms_prompt? ===");
const kt = await open({ language_code: "multi", keyterms_prompt: JSON.stringify(["positional encoding", "softmax"]) });
log(`  sent two terms; Begin.configuration = ${JSON.stringify(kt.begin?.configuration)}`);
log(`  keyterms_prompt present in Begin: ${JSON.stringify(kt.begin ?? {}).includes("keyterms")}`);

// ── 4. Ten opens AT ONCE, from cold. ───────────────────────────────────────
// The sections above leave slots draining, so this waits them out first —
// otherwise the split measures our own leftovers rather than the account cap.
log("\n=== 4. ten parallel opens (Promise.all), after a 30 s cooldown ===");
await new Promise((r) => setTimeout(r, 30000));
const many = await Promise.all(
  Array.from({ length: 10 }, () => open({ language_code: "multi" }, { hold: 5000 }))
);
const gotBegin = many.filter((r) => r.result === "begin");
const refused = many.filter((r) => r.result !== "begin");
log(`  Begin: ${gotBegin.length}   refused: ${refused.length}`);
const kinds = new Map();
for (const r of refused) {
  const k = `close ${r.closeCode} ${r.error ? JSON.stringify({ error_code: r.error.error_code, error: r.error.error }) : "(no Error frame)"}`;
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
for (const [k, n] of kinds) log(`    x${n}  ${k}`);

// ── 5. How long does a closed slot take to free? ───────────────────────────
// §5 says "slots take seconds to free". This times it: poll one open per
// second, starting the moment the ten above have all closed.
log("\n=== 5. time for a slot to free after the cap was hit ===");
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  const r = await open({ language_code: "multi" });
  const dt = Date.now() - t0;
  if (r.result === "begin") { log(`  first successful open ${(dt / 1000).toFixed(1)} s after the parallel burst closed`); break; }
  if (i % 4 === 0) log(`  +${(dt / 1000).toFixed(1)} s: still ${r.error?.error_code ?? r.closeCode ?? r.result}`);
  await new Promise((r) => setTimeout(r, 1000));
}
