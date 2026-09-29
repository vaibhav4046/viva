#!/usr/bin/env node
/**
 * Build the deck PDF.
 *
 *   node docs/deck/build.mjs
 *
 * 1. Every element marked data-num="<key>" must show the value numbers.json holds for that key.
 * 2. The page must have nine slides, no dash characters (U+2014, U+2013) and no exclamation marks in text.
 * 3. Playwright prints docs/deck/index.html to docs/deck/viva-oral.pdf (1280 by 720, background on).
 *
 * One Chromium, closed at the end.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const numbers = JSON.parse(readFileSync(join(here, "..", "..", "numbers.json"), "utf8"));
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await page.goto(pathToFileURL(join(here, "index.html")).href, { waitUntil: "load" });

  const shown = await page.$$eval("[data-num]", (els) => els.map((e) => [e.getAttribute("data-num"), e.textContent.trim()]));
  for (const [key, text] of shown) {
    const want = numbers[key]?.value;
    const ok = want !== undefined && Number(text) === want;
    if (!ok) failed = true;
    console.log(`${ok ? "pass" : "FAIL"} ${key}: slide shows ${text}, numbers.json has ${want}`);
  }

  const slides = await page.locator(".slide").count();
  console.log(`${slides === 9 ? "pass" : "FAIL"} nine slides (found ${slides})`);
  if (slides !== 9) failed = true;

  const text = await page.evaluate(() => document.body.innerText);
  const dashes = new Set([String.fromCharCode(0x2014), String.fromCharCode(0x2013), "!"]);
  const bad = [...text].filter((c) => dashes.has(c)).length;
  console.log(`${bad === 0 ? "pass" : "FAIL"} no dashes or exclamation marks in slide text (${bad} found)`);
  if (bad) failed = true;

  if (!failed) {
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: join(here, "viva-oral.pdf"), width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true });
    console.log("wrote docs/deck/viva-oral.pdf");
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
