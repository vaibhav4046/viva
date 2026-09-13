/*
 * Firm up every claim before it goes to AssemblyAI as feedback.
 *
 * Nothing here is asserted from documentation or memory. Each item is a live
 * probe with the response recorded, because feedback that turns out to be
 * wrong is worse than no feedback.
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
const line = (s) => console.log(s);

async function token(seconds) {
  const r = await fetch(`https://streaming.assemblyai.com/v3/token?expires_in_seconds=${seconds}`, {
    headers: { Authorization: KEY },
  });
  const body = await r.text();
  return { status: r.status, body };
}

// ── 1. What expiry will the token endpoint actually grant? ─────────────────
line("=== 1. /v3/token expires_in_seconds bounds ===");
for (const s of [1, 30, 60, 600, 3600, 86400, 604800, -1]) {
  const r = await token(s);
  let granted = null;
  try {
    const j = JSON.parse(r.body);
    granted = j.expires_in_seconds ?? null;
    // A JWT's own exp is the number that matters, not the one echoed back.
    if (j.token) {
      const parts = String(j.token).split(".");
      if (parts.length === 3) {
        const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (p.exp) granted = `${j.expires_in_seconds} (jwt exp in ${p.exp - Math.floor(Date.now() / 1000)}s)`;
      }
    }
  } catch {
    /* not JSON */
  }
  line(`  asked ${String(s).padStart(7)}s -> ${r.status} ${granted !== null ? "granted " + granted : r.body.slice(0, 140)}`);
  await new Promise((r) => setTimeout(r, 400));
}

// ── 2. Which language codes does streaming actually accept? ────────────────
line("\n=== 2. streaming language_code, one socket per code ===");
const CLAIMED_BY_THE_FORM = 18;
const CANDIDATES = (
  "en es de fr it pt tr nl sv no da fi hi vi ar he ja ur zh ru ko ca gl ro et fa yue af mr zu xh nn " +
  "pl uk id th ms bn ta te el cs hu multi"
).split(" ");
const accepted = [];
const refused = [];
for (const code of CANDIDATES) {
  const t = await token(60);
  let tok = null;
  try { tok = JSON.parse(t.body).token; } catch { /* */ }
  if (!tok) { line(`  ${code}: could not mint a token (${t.status})`); continue; }
  const q = new URLSearchParams({ token: tok, encoding: "pcm_s16le", sample_rate: "16000", language_code: code });
  const res = await new Promise((resolve) => {
    const to = setTimeout(() => resolve({ r: "timeout" }), 10000);
    const ws = new WebSocket("wss://streaming.assemblyai.com/v3/ws?" + q);
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "Begin") { clearTimeout(to); resolve({ r: "ok", model: m.configuration?.model ?? null }); ws.close(); }
    };
    ws.onclose = (e) => { clearTimeout(to); resolve({ r: "closed", code: e.code }); };
    ws.onerror = () => {};
  });
  if (res.r === "ok") { accepted.push([code, res.model]); }
  else { refused.push([code, res.code ?? res.r]); }
  await new Promise((r) => setTimeout(r, 1400));
}
line(`  accepted (${accepted.length}): ${accepted.map(([c]) => c).join(" ")}`);
line(`  refused  (${refused.length}): ${refused.map(([c, k]) => c + "/" + k).join(" ")}`);
const models = new Map();
for (const [c, m] of accepted) models.set(m, (models.get(m) ?? 0) + 1);
line(`  models seen: ${[...models].map(([m, n]) => `${m} x${n}`).join(", ")}`);
line(`  the submission form says ${CLAIMED_BY_THE_FORM}; streaming accepted ${accepted.length}`);

fs.writeFileSync(
  ".viva/api-feedback-evidence.json",
  JSON.stringify({ at: new Date().toISOString(), accepted, refused }, null, 2)
);
line("\nevidence written to .viva/api-feedback-evidence.json");
