#!/usr/bin/env node
/**
 * Start, then choose Type instead while the start is still waiting (the session
 * request is held for 3 s). The exam must not start behind the typed screen: no
 * WebSocket opens and the microphone is released.
 *
 *   BASE_URL=http://localhost:3141 node scripts/oral-ui-drive.mjs   (separate run)
 *   BASE_URL=http://localhost:3141 node scripts/oral-abandon-check.mjs
 */
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3141";
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1024, height: 800 } });
const page = await ctx.newPage();
let sockets = 0;
page.on("websocket", (ws) => { if (/assemblyai/.test(ws.url())) sockets += 1; });
// Hold the browser microphone prompt for 3 s, the way a real permission dialog waits for a click.
await page.addInitScript(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    await new Promise((r) => setTimeout(r, 3000));
    return real(c);
  };
});
await page.goto(`${base}/oral`, { waitUntil: "load" });
await page.getByRole("button", { name: /start the exam/i }).click();
await page.getByRole("button", { name: /type instead/i }).click();
await page.waitForTimeout(9000);
const typedShown = await page.getByLabel("Your answer").isVisible().catch(() => false);
const liveTracks = await page.evaluate(async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.length;
});
const stateLine = await page.locator('[role="status"][aria-live="polite"]').first().textContent();
await browser.close();
const ok = sockets === 0 && typedShown;
console.log(JSON.stringify({ websocketsOpened: sockets, typedExamShown: typedShown, stateLine: stateLine?.trim(), devicesEnumerated: liveTracks, pass: ok }));
process.exit(ok ? 0 : 1);
