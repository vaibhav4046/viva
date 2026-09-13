import fs from "node:fs";
const B = "https://viva-five-murex.vercel.app";
const wav = fs.readFileSync(".viva/audio/confusion-16k.wav");
const runs = [];
const N = Number(process.env.RUNS ?? 12);   // README quotes twelve; keep them the same number.
for (let i = 0; i < N; i++) {
  const form = new FormData();
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "clip.wav");
  form.append("subjectId", "course_transformers_w4");
  form.append("mode", "study");
  const t0 = Date.now();
  const r = await fetch(`${B}/api/voice/transcribe`, { method: "POST", body: form });
  const j = await r.json();
  const wall = Date.now() - t0;
  runs.push({ wall, requestTimeMs: Math.round(j.requestTimeMs ?? 0), mode: j.mode, confidence: j.confidence, sessionId: j.sessionId });
  console.log(`  run ${i + 1}: wall ${wall} ms · provider ${Math.round(j.requestTimeMs ?? 0)} ms · ${j.mode} · confidence ${j.confidence} · session ${j.sessionId}`);
}
// The README claims the confidence repeats exactly and the ids never do.
const confs = new Set(runs.map((r) => String(r.confidence)));
const ids = new Set(runs.map((r) => r.sessionId));
console.log(`\ndistinct confidence values across ${runs.length} runs: ${confs.size} ${[...confs].join(", ")}`);
console.log(`distinct session ids across ${runs.length} runs: ${ids.size}`);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\nmedian wall (route round trip): ${med(runs.map(r => r.wall))} ms`);
console.log(`median provider request_time_ms : ${med(runs.map(r => r.requestTimeMs))} ms`);
