/*
 * Renders the submission's static assets from their HTML sources, in Chromium:
 *   docs/submission/slides.html → docs/submission/slides.pdf (7 pages, 1280×720)
 *   docs/submission/cover.html  → docs/submission/cover.png (1600×900)
 *
 * Both pages reference the screenshots in docs/submission/screenshots, so run
 * `npm run test:redteam-e2e` first to refresh those.
 *
 * Usage: node scripts/render-submission-assets.mjs
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const DIR = path.resolve("docs/submission");
for (const f of ["slides.html", "cover.html"]) {
  const src = fs.readFileSync(path.join(DIR, f), "utf8");
  if (src.includes("⟨")) {
    console.error(`${f} still has an unfilled ⟨placeholder⟩; fill it before rendering.`);
    process.exit(1);
  }
}

const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) });

const slides = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await slides.goto(`file://${path.join(DIR, "slides.html")}`);
await slides.waitForLoadState("networkidle");
await slides.pdf({ path: path.join(DIR, "slides.pdf"), width: "1280px", height: "720px", printBackground: true, pageRanges: "" });
console.log("wrote docs/submission/slides.pdf");

const cover = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await cover.goto(`file://${path.join(DIR, "cover.html")}`);
await cover.waitForLoadState("networkidle");
await cover.screenshot({ path: path.join(DIR, "cover.png") });
console.log("wrote docs/submission/cover.png");

await browser.close();
