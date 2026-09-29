#!/usr/bin/env node
/**
 * Demo preflight: run this before the Plan A recording. Prints GO or NO-GO with reasons.
 *
 *   node scripts/demo-preflight.mjs                          # production
 *   node scripts/demo-preflight.mjs --base http://localhost:3000
 *
 * Checks the deployment the take will use:
 *   1 health        GET /api/health
 *   2 readiness     GET /api/health/ready (model provider usable, storage durability)
 *   3 token mint    GET /api/voice-agent/token returns a token (only its length is printed)
 *   4 sample course GET /api/oral/session for the sample course, with the verify_claim tool
 *   5 misconception POST /api/oral/tool verify_claim on the scripted false claim returns
 *                   "contradicted" with a quote and a page
 *   6 pages         /oral answers; /recorded, /privacy, /terms answer (warning only)
 *
 * It never prints a token, a key or a cookie. Every request has a 25 s timeout.
 * Exit 0 on GO, 1 on NO-GO.
 */
const argAt = process.argv.indexOf("--base");
const base = (argAt > 0 ? process.argv[argAt + 1] : process.env.DEMO_BASE ?? "https://viva-five-murex.vercel.app").replace(/\/$/, "");
const SAMPLE = "course_transformers_w4";
const CLAIM = "multi-head attention runs a single head over the input";
const TIMEOUT_MS = 25_000;

const blockers = [];
const warnings = [];
const lines = [];
const ok = (name, detail) => lines.push(`pass  ${name}${detail ? `: ${detail}` : ""}`);
const fail = (name, why) => { blockers.push(`${name}: ${why}`); lines.push(`FAIL  ${name}: ${why}`); };
const warn = (name, why) => { warnings.push(`${name}: ${why}`); lines.push(`warn  ${name}: ${why}`); };

async function call(path, init) {
  const started = Date.now();
  try {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, json: null, ms: Date.now() - started, error: e?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : (e?.cause?.code ?? e?.message ?? "request failed") };
  }
}

const health = await call("/api/health");
if (health.status === 200 && health.json?.ok === true) ok("health", `${health.ms} ms, version ${health.json.version ?? "unknown"}`);
else fail("health", health.error ?? `HTTP ${health.status}`);

const ready = await call("/api/health/ready");
if (ready.status !== 200 || !ready.json) fail("readiness", ready.error ?? `HTTP ${ready.status}`);
else {
  const r = ready.json;
  if (r.provider?.usable === true) ok("model provider", `usable, model ${r.provider.model ?? "unnamed"}`);
  else fail("model provider", "no usable model provider; verify_claim cannot catch a misconception without one");
  if (r.durable === true) ok("storage", `durable (${r.database?.backend ?? "unknown backend"})`);
  else warn("storage", "ephemeral: the learner map resets on restart. Say so on camera or use a durable deployment.");
}

const token = await call("/api/voice-agent/token");
if (token.status === 200 && typeof token.json?.token === "string" && token.json.token.length > 20) {
  ok("token mint", `${token.ms} ms, ${token.json.token.length} characters, expires in ${token.json.expiresInSeconds ?? token.json.expires_in_seconds ?? "unknown"} s`);
} else {
  fail("token mint", token.error ?? `HTTP ${token.status}${token.json?.error?.code ? ` ${token.json.error.code}` : ""}`);
}

const session = await call(`/api/oral/session?subjectId=${SAMPLE}`);
if (session.status === 200 && session.json?.subjectId === SAMPLE && session.json.system_prompt) {
  const names = (session.json.tools ?? []).map((t) => t.name);
  if (names.includes("verify_claim")) ok("sample course", `${SAMPLE}, tools: ${names.join(", ")}`);
  else fail("sample course", `session config has no verify_claim tool (tools: ${names.join(", ") || "none"})`);
} else fail("sample course", session.error ?? `HTTP ${session.status}, subjectId ${session.json?.subjectId ?? "missing"}`);

const verdict = await call("/api/oral/tool", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ callId: "preflight-1", name: "verify_claim", subjectId: SAMPLE, sessionId: "preflight", arguments: { claim: CLAIM, concept: "multi-head attention" } }),
});
const result = verdict.json?.result;
if (verdict.status === 200 && result?.verdict === "contradicted" && result.quote && result.page != null) {
  ok("misconception check", `contradicted, page ${result.page}, ${verdict.ms} ms, quote ${String(result.quote).length} characters`);
} else if (verdict.status === 200 && result) {
  fail("misconception check", `expected contradicted with a quote and page, got ${result.verdict ?? "no verdict"} (page ${result.page ?? "none"})`);
} else fail("misconception check", verdict.error ?? `HTTP ${verdict.status}${verdict.json?.error?.code ? ` ${verdict.json.error.code}` : ""}`);

for (const [path, required] of [["/oral", true], ["/recorded", false], ["/privacy", false], ["/terms", false]]) {
  const res = await call(path);
  if (res.status === 200) ok(`page ${path}`, `${res.ms} ms`);
  else if (required) fail(`page ${path}`, res.error ?? `HTTP ${res.status}`);
  else warn(`page ${path}`, res.error ?? `HTTP ${res.status}; the deployed build may be older than the branch you recorded against`);
}

console.log(`Target: ${base}`);
console.log(lines.join("\n"));
if (blockers.length === 0) {
  console.log(`\nGO${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);
  process.exit(0);
}
console.log(`\nNO-GO: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`);
for (const b of blockers) console.log(`  - ${b}`);
process.exit(1);
