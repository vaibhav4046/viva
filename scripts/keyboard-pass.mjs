#!/usr/bin/env node
/**
 * Keyboard-only pass over the golden path, recorded as evidence.
 *
 *   BASE_URL=http://localhost:3141 node scripts/keyboard-pass.mjs
 *
 * 1. /oral idle: Tab through every stop, recording its name, whether a focus
 *    ring is drawn, and whether the sticky control bar covers it (WCAG 2.4.11).
 * 2. Start the exam with Enter on the focused Start button, wait for Listening
 *    against the live service with a fake microphone, end it with the
 *    Alt+Shift+M shortcut, and check the debrief area appears.
 * 3. Type instead: reach the typed exam by keyboard, type an answer, submit it
 *    with Enter on the button, and read the graded result.
 * Output: docs/evidence/a11y/keyboard-pass.<date>.json
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3141";
const date = new Date().toISOString().slice(0, 10);
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 }, permissions: ["microphone"], reducedMotion: "reduce" });
const page = await ctx.newPage();
const report = { measuredOn: new Date().toISOString(), base, idleTabStops: [], start: {}, typed: {}, notes: [] };

const focusInfo = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bar = document.querySelector(".oral-controls")?.getBoundingClientRect();
    const head = document.querySelector("header")?.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 50);
    return {
      tag: el.tagName.toLowerCase(),
      name,
      ringDrawn: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2,
      coveredByControlBar: !!bar && el.closest(".oral-controls") == null && r.bottom > bar.top && r.top < bar.bottom,
      coveredByHeader: !!head && r.top < head.bottom && r.bottom > head.top,
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

try {
  await page.goto(`${base}/oral`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const info = await focusInfo();
    if (!info) break;
    report.idleTabStops.push(info);
    if (info.name === "Type instead") break;
  }

  // Start with the keyboard.
  await page.getByRole("button", { name: /start the exam/i }).focus();
  await page.keyboard.press("Enter");
  const t0 = Date.now();
  await page.waitForFunction(() => /Listening|Speaking/.test(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ""), null, { timeout: 60000 });
  report.start.reachedListeningOrSpeakingMs = Date.now() - t0;
  report.start.stateLine = (await page.locator('[role="status"][aria-live="polite"]').first().textContent())?.trim();
  await page.keyboard.press("Alt+Shift+KeyM");
  await page.waitForSelector("text=/Nothing to debrief yet|Debrief/", { timeout: 20000 });
  report.start.endedWithShortcut = true;
  report.start.stateLineAfter = (await page.locator('[role="status"][aria-live="polite"]').first().textContent())?.trim();

  // Typed path.
  await page.goto(`${base}/oral`, { waitUntil: "load" });
  await page.getByRole("button", { name: /type instead/i }).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("textarea", { timeout: 20000 });
  report.typed.textareaFocusedOnOpen = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
  report.typed.question = (await page.locator('section[aria-label="Question"]').textContent())?.replace(/^Question/, "").trim();
  await page.keyboard.type("Attention lets each token look at every other token, weighting them by relevance.");
  await page.keyboard.press("Tab");
  report.typed.focusAfterTab = await focusInfo();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".oral-result", { timeout: 30000 });
  report.typed.result = (await page.locator(".oral-result").innerText()).replace(/\s+/g, " ").slice(0, 240);
} catch (e) {
  report.failure = String(e).slice(0, 300);
} finally {
  await browser.close();
}

fs.mkdirSync("docs/evidence/a11y", { recursive: true });
fs.writeFileSync(`docs/evidence/a11y/keyboard-pass.${date}.json`, JSON.stringify(report, null, 2) + "\n", "utf8");
const stops = report.idleTabStops;
console.log(`idle tab stops=${stops.length} ringMissing=${stops.filter((s) => !s.ringDrawn).length} coveredByControlBar=${stops.filter((s) => s.coveredByControlBar).length} coveredByHeader=${stops.filter((s) => s.coveredByHeader).length}`);
console.log("start:", JSON.stringify(report.start));
console.log("typed:", JSON.stringify(report.typed).slice(0, 400));
console.log("failure:", report.failure ?? "none");
