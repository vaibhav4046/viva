/**
 * Live voice proof: WAV file -> AssemblyAIProvider (sync) -> asserted transcript.
 * Usage: ASSEMBLYAI_API_KEY=... node scripts/verify-live-voice.mjs <wav> <kw1> [kw2...]
 * Spends a few seconds of AssemblyAI credit. Never run in CI.
 */
import { readFile } from "node:fs/promises";

const [wavPath, ...keywords] = process.argv.slice(2);
if (!wavPath || !keywords.length || !process.env.ASSEMBLYAI_API_KEY) {
  console.error("usage: ASSEMBLYAI_API_KEY=... node scripts/verify-live-voice.mjs <wav> <kw...>");
  process.exit(2);
}

// Run with tsx (handles the TS source import).
const { AssemblyAIProvider } = await import("../src/lib/assemblyai.ts");
const audio = await readFile(wavPath);
const provider = new AssemblyAIProvider("sync");
const started = Date.now();
const r = await provider.transcribe({ audio, contentType: "audio/wav" });
console.log(JSON.stringify({
  text: r.text,
  confidence: r.confidence,
  audioDurationMs: r.audioDurationMs,
  requestTimeMs: r.requestTimeMs,
  latencyMs: r.latencyMs,
  sessionId: r.sessionId,
  provider: r.provider,
  mode: r.mode,
  clientMs: Date.now() - started,
}, null, 2));
const low = r.text.toLowerCase();
const missing = keywords.filter((k) => !low.includes(k.toLowerCase()));
if (!r.text || missing.length) {
  console.error(`LIVE-FAIL: missing keywords: ${missing.join(", ")}`);
  process.exit(1);
}
if (r.provider !== "assemblyai" || r.demoFixture !== false || !r.sessionId) {
  console.error("LIVE-FAIL: provenance fields wrong");
  process.exit(1);
}
console.log("LIVE-PASS: real AssemblyAI transcript with expected content");
