// Rebuilds numbers.json from the committed evidence files. Every entry names its
// evidence file and the command that regenerates it; --check fails if a published
// value no longer appears in its evidence file.
//   node scripts/probes/oral-numbers.mjs [--check]
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = "docs/evidence/probes";
const latest = (re) => readdirSync(dir).filter((f) => re.test(f)).sort().at(-1);
const publish = {
  roundtrip: ["sessionReadyMs", "firstAudioMs", "toolHttpMs", "toolCallToResultMs"],
  bargein: ["speechDetectedMs", "stopFromVoiceOnsetMs", "interruptedReplyDoneMs"],
  bargein_tool: ["speechDetectedMs", "stopFromVoiceOnsetMs"],
  resume: ["recoveryMs"],
};
// A published key can differ from the evidence key when the evidence name over-claims.
// recoveryMs is what the probe records; the service refused session.resume, so what it
// times is a continuation in a fresh session, and the published name says that.
const renamed = { "oral.resume.recoveryMs": "oral.resume.continuationMs" };
const notes = {
  "oral.resume.continuationMs": "Time from the socket drop to session.ready on a fresh session. A live session.resume was refused with session_not_found in every trial, so this is not a resumed session: the exam continues fresh with the last turns in the prompt.",
  "oral.bargein.stopFromVoiceOnsetMs": "Detection latency: first loud learner sample to the client's flush call, which runs when the service reports speech. The probe's playback is a stub, so this is not a measured playback stop.",
  "oral.bargein_tool.stopFromVoiceOnsetMs": "Detection latency: first loud learner sample to the client's flush call, which runs when the service reports speech. The probe's playback is a stub, so this is not a measured playback stop.",
};
const numbers = {};
for (const [scenario, keys] of Object.entries(publish)) {
  const file = latest(new RegExp(`^oral-live-${scenario}\\.\\d{4}-\\d{2}-\\d{2}\\.json$`));
  if (!file) continue;
  const ev = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const key of keys) {
    const s = ev.summary[key];
    if (!s || s.median === null || s.n < 1) continue;
    const evidenceKey = `oral.${scenario}.${key}`;
    const name = renamed[evidenceKey] ?? evidenceKey;
    numbers[name] = { value: s.median, n: s.n, date: ev.measuredOn.slice(0, 10), evidence: `${dir}/${file}`, cmd: ev.cmd, ...(notes[name] ? { note: notes[name] } : {}) };
  }
}
const vfile = latest(/^verify-claim-live-\d{4}-\d{2}-\d{2}\.json$/);
if (vfile) {
  const ev = JSON.parse(readFileSync(join(dir, vfile), "utf8"));
  const date = ev.measuredOn.slice(0, 10);
  const cmd = "npx tsx --env-file=.env.local scripts/probes/oral-verify-eval.mts";
  const add = (key, value, n) => { if (value !== null && value !== undefined) numbers[key] = { value, n, date, evidence: `${dir}/${vfile}`, cmd }; };
  add("oral.verifyClaim.claimsInSet", ev.n, ev.n);
  add("oral.verifyClaim.falseSupported", ev.metrics.falseSupported, ev.n);
  add("oral.verifyClaim.supportedPrecision", ev.metrics.supported.precision, ev.n);
  add("oral.verifyClaim.supportedRecall", ev.metrics.supported.recall, ev.n);
  add("oral.verifyClaim.contradictedPrecision", ev.metrics.contradicted.precision, ev.n);
  add("oral.verifyClaim.contradictedRecall", ev.metrics.contradicted.recall, ev.n);
  add("oral.verifyClaim.medianJudgeMs", ev.latencyMs.median, ev.modelCalls);
  add("oral.verifyClaim.p95JudgeMs", ev.latencyMs.p95, ev.modelCalls);
}

if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [k, v] of Object.entries(numbers)) {
    const text = readFileSync(v.evidence, "utf8");
    if (!text.includes(String(v.value))) { console.error("value not in evidence:", k, v.value); bad++; }
  }
  const onDisk = existsSync("numbers.json") ? JSON.parse(readFileSync("numbers.json", "utf8")) : {};
  for (const [k, v] of Object.entries(numbers)) if (JSON.stringify(onDisk[k]) !== JSON.stringify(v)) { console.error("numbers.json is stale for", k); bad++; }
  console.log(bad ? `FAIL ${bad}` : `OK ${Object.keys(numbers).length} numbers match their evidence`);
  process.exit(bad ? 1 : 0);
}
writeFileSync("numbers.json", JSON.stringify(numbers, null, 2) + "\n", "utf8");
console.log(`wrote numbers.json with ${Object.keys(numbers).length} entries`);
