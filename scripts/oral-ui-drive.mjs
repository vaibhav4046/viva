#!/usr/bin/env node
/**
 * Drives the real /oral screen against the real Voice Agent service with
 * Chromium's fake microphone, and records what the screen actually showed:
 * the state line sequence, the level meter readings, the live captions, the
 * ?diag=1 numbers and the debrief that follows. One Chromium, one short exam.
 *
 *   BASE_URL=http://localhost:3141 node scripts/oral-ui-drive.mjs
 *
 * The fake device plays a generated tone, not speech, so this proves the screen
 * wiring (states, captions, meters, diagnostics, end and debrief), not the
 * examiner's grading. Output: docs/evidence/visual/oral-ui-drive.<date>.json
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3141";
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const wavName = arg("--wav"); // e.g. student-misconception (from fixtures/audio)
const padSec = Number(arg("--pad") ?? 22);
const outDir = process.env.TEMP ?? ".";

/** Prepend silence to a 16-bit PCM WAV so the student speaks after the greeting. The fake mic plays the file once from the moment the page opens the microphone. */
function padWav(inPath, outPath, seconds) {
  const b = fs.readFileSync(inPath);
  const fmt = b.indexOf("fmt ");
  const channels = b.readUInt16LE(fmt + 10);
  const rate = b.readUInt32LE(fmt + 12);
  const bits = b.readUInt16LE(fmt + 22);
  const data = b.indexOf("data");
  const size = b.readUInt32LE(data + 4);
  const pcm = b.subarray(data + 8, data + 8 + size);
  const silence = Buffer.alloc(Math.round(seconds * rate) * channels * (bits / 8));
  const header = Buffer.from(b.subarray(0, data + 8));
  header.writeUInt32LE(4 + (data - 12) + 8 + silence.length + pcm.length, 4);
  header.writeUInt32LE(silence.length + pcm.length, data + 4);
  fs.writeFileSync(outPath, Buffer.concat([header, silence, pcm]));
}
let fakeAudio = [];
if (wavName) {
  const padded = `${outDir}/oral-drive-${wavName}.wav`;
  padWav(`fixtures/audio/${wavName}.wav`, padded, padSec);
  fakeAudio = [`--use-file-for-fake-audio-capture=${padded}%noloop`];
}
const date = new Date().toISOString().slice(0, 10);
const out = `docs/evidence/visual/oral-ui-drive${wavName ? "-" + wavName : ""}.${date}.json`;
const shots = `docs/evidence/visual/${date}`;
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", ...fakeAudio],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"], reducedMotion: "reduce" });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

await page.addInitScript(() => {
  window.__cls = { total: 0, unexpected: 0, shifts: [] };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__cls.total += e.value;
      if (!e.hadRecentInput) window.__cls.unexpected += e.value;
      window.__cls.shifts.push({ t: Math.round(e.startTime), v: Math.round(e.value * 10000) / 10000, input: e.hadRecentInput });
    }
  }).observe({ type: "layout-shift", buffered: true });
});
const result = { measuredOn: new Date().toISOString(), base, states: [], meterSamples: [], captions: [], diag: null, debrief: null, errors };
try {
  await page.goto(`${base}/oral?diag=1`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    window.__seen = [];
    const el = document.querySelector('[role="status"][aria-live="polite"]');
    const push = () => window.__seen.push({ t: Math.round(performance.now()), text: el.textContent.trim() });
    push();
    new MutationObserver(push).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: /start the exam/i }).click();
  const t0 = Date.now();

  // Sample the meters and the examiner card for up to 25 s, stop early once the examiner has spoken and gone quiet.
  let spoke = false;
  const limitMs = wavName ? 95000 : 25000;
  let sawChecking = false;
  while (Date.now() - t0 < limitMs) {
    const snap = await page.evaluate(() => ({
      state: document.querySelector('[role="status"][aria-live="polite"]')?.textContent?.trim(),
      learner: Number(document.querySelector('[role="meter"][aria-label="You level"]')?.getAttribute("aria-valuenow")),
      examiner: Number(document.querySelector('[role="meter"][aria-label="Examiner level"]')?.getAttribute("aria-valuenow")),
      card: document.querySelector('section[aria-label="Examiner"] p:nth-of-type(2)')?.textContent?.trim() ?? "",
    }));
    result.meterSamples.push({ ms: Date.now() - t0, ...snap });
    if (snap.state === "Speaking") spoke = true;
    if (/^Checking/.test(snap.state ?? "") && !sawChecking) {
      sawChecking = true;
      await page.screenshot({ path: `${shots}/live-oral-checking-1280.png` });
    }
    const cards = await page.locator(".oral-sources-body article").count();
    if (wavName ? cards > 0 && snap.state === "Listening" : spoke && snap.state === "Listening") break;
    await page.waitForTimeout(250);
    if (spoke && !result.shotSpeaking) {
      await page.screenshot({ path: `${shots}/live-oral-speaking-1280.png` });
      result.shotSpeaking = true;
    }
  }
  await page.screenshot({ path: `${shots}/live-oral-after-greeting-1280.png` });
  result.states = await page.evaluate(() => window.__seen);
  result.layoutShift = await page.evaluate(() => window.__cls);
  result.sourceCards = await page.evaluate(() => [...document.querySelectorAll(".oral-sources-body article")].map((a) => a.innerText));
  result.transcript = await page.evaluate(() => [...document.querySelectorAll(".oral-transcript li")].map((l) => l.innerText.replace(/\s+/g, " ")));
  result.examinerCard = await page.evaluate(() => document.querySelector('section[aria-label="Examiner"]')?.textContent?.trim() ?? "");
  result.diag = await page.evaluate(() => document.querySelector("aside.oral-diag")?.innerText ?? "");

  await page.getByRole("button", { name: /end the exam/i }).click();
  await page.waitForSelector("text=/Nothing to debrief yet|Debrief|could not be built/", { timeout: 20000 });
  await page.waitForTimeout(600);
  result.debrief = await page.evaluate(() => (document.querySelector(".debrief, .oral-alert")?.innerText ?? "").slice(0, 400));
  result.statesAfterEnd = await page.evaluate(() => window.__seen.slice(-3));
  await page.screenshot({ path: `${shots}/live-oral-ended-1280.png`, fullPage: true });
} catch (e) {
  result.failure = String(e).slice(0, 300);
  await page.screenshot({ path: `${shots}/live-oral-failure-1280.png` }).catch(() => {});
} finally {
  await browser.close();
}

fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
const seq = [...new Set(result.states.map((s) => s.text))];
console.log("state line sequence:", seq.join(" > "));
console.log("max meter readings:", { learner: Math.max(0, ...result.meterSamples.map((s) => s.learner || 0)), examiner: Math.max(0, ...result.meterSamples.map((s) => s.examiner || 0)) });
console.log("layout shift (whole run):", JSON.stringify({ ...result.layoutShift, shifts: result.layoutShift?.shifts?.length }));
console.log("failure:", result.failure ?? "none", "| console errors:", errors.length, "| out:", out);
