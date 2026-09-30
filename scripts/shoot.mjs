#!/usr/bin/env node
/**
 * Screenshot matrix (design directive 7.9).
 *
 *   BASE_URL=http://localhost:3121 node scripts/shoot.mjs
 *   node scripts/shoot.mjs --only landing,oral --widths 390,1440 --viewport-only
 *   node scripts/shoot.mjs --skip-dev     against a production build: leave out surfaces marked devOnly
 *
 * Drives every surface in design/surfaces.json at nine widths with ONE Chromium,
 * saves PNGs to docs/evidence/visual/<date>/<surface>-<width>.png, and prints a
 * table of horizontal overflow, console errors, undersized tap targets and body
 * text under 14 px. Exit code 1 on any overflow or console error.
 *
 * Numbers from this table are not a substitute for looking: open the PNGs.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ALL_WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
const widths = value("--widths") ? value("--widths").split(",").map(Number) : ALL_WIDTHS;
const only = value("--only") ? value("--only").split(",") : null;
const viewportOnly = flag("--viewport-only");
const base = process.env.BASE_URL ?? "http://localhost:3121";
const date = value("--date") ?? new Date().toISOString().slice(0, 10);
const out = path.join("docs", "evidence", "visual", date);
fs.mkdirSync(out, { recursive: true });

const surfaces = JSON.parse(fs.readFileSync("design/surfaces.json", "utf8")).filter(
  (s) => (!only || only.includes(s.name)) && !(flag("--skip-dev") && s.devOnly)
);

const measure = () => {
  const doc = document.documentElement;
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const small = [...document.querySelectorAll("button, input, select, textarea, [role=button], nav a, a.btn-primary, a.btn-ghost")]
    .filter(visible)
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width < 24 || r.height < 24;
    }).length;
  const tinyText = [...document.querySelectorAll("p, li, td, label, span, a, button")]
    .filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .filter(visible)
    .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).length;
  return {
    overflow: doc.scrollWidth > doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    smallTargets: small,
    tinyText,
    h1: document.querySelectorAll("h1").length,
  };
};

const browser = await chromium.launch();
const rows = [];
try {
  for (const s of surfaces) {
    for (const w of widths) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: w < 768 ? 844 : 900 },
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text().slice(0, 120));
      });
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
      try {
        await page.goto(base + s.path, { waitUntil: "load", timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(350);
        const m = await page.evaluate(measure);
        const file = `${s.name}-${w}.png`;
        await page.screenshot({ path: path.join(out, file), fullPage: !viewportOnly });
        rows.push({ surface: s.name, width: w, ...m, consoleErrors: errors.length, note: errors[0] ?? "" });
      } catch (e) {
        rows.push({ surface: s.name, width: w, overflow: true, consoleErrors: 1, note: String(e).slice(0, 100) });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.table(rows.map(({ note, ...r }) => r));
fs.writeFileSync(path.join(out, "matrix.json"), JSON.stringify(rows, null, 2) + "\n", "utf8");
const bad = rows.filter((r) => r.overflow || r.consoleErrors);
console.log(`surfaces=${surfaces.length} widths=${widths.length} rows=${rows.length} overflow=${rows.filter((r) => r.overflow).length} consoleErrors=${rows.reduce((a, r) => a + r.consoleErrors, 0)} out=${out}`);
for (const r of bad.slice(0, 8)) console.log(`  FAIL ${r.surface}@${r.width}: ${r.note}`);
process.exit(bad.length ? 1 : 0);
