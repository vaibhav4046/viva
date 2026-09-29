#!/usr/bin/env node
/**
 * axe-core over every surface in design/surfaces.json at a phone and a desktop
 * width, with one Chromium. Reports every violation with its impact and fails on
 * serious or critical. Rules: WCAG 2.0 A and AA, 2.1 AA, 2.2 AA (axe covers the
 * subset of 2.2 it can test, e.g. target size), plus best-practice.
 *
 *   BASE_URL=http://localhost:3141 node scripts/axe-matrix.mjs [--only oral-idle,debrief] [--skip-dev]
 *
 * Output: docs/evidence/a11y/axe-matrix.<date>.json
 */
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const base = process.env.BASE_URL ?? "http://localhost:3141";
const date = new Date().toISOString().slice(0, 10);
const widths = [390, 1440];
const surfaces = JSON.parse(fs.readFileSync("design/surfaces.json", "utf8")).filter(
  (s) => (!only || only.includes(s.name)) && !(args.includes("--skip-dev") && s.devOnly)
);

const browser = await chromium.launch();
const rows = [];
try {
  for (const s of surfaces) {
    for (const w of widths) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 768 ? 844 : 900 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      try {
        await page.goto(base + s.path, { waitUntil: "load", timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(600);
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
        rows.push({
          surface: s.name,
          width: w,
          violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0]?.target?.join(" ").slice(0, 120) })),
          passes: res.passes.length,
        });
      } catch (e) {
        rows.push({ surface: s.name, width: w, error: String(e).slice(0, 160), violations: [] });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

fs.mkdirSync("docs/evidence/a11y", { recursive: true });
fs.writeFileSync(`docs/evidence/a11y/axe-matrix.${date}.json`, JSON.stringify({ measuredOn: new Date().toISOString(), base, widths, rows }, null, 2) + "\n", "utf8");
const bad = rows.flatMap((r) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ ...v, surface: r.surface, width: r.width })));
const other = rows.flatMap((r) => r.violations.filter((v) => !(v.impact === "serious" || v.impact === "critical")).map((v) => `${r.surface}@${r.width} ${v.impact} ${v.id} x${v.nodes}`));
console.log(`surfaces=${surfaces.length} pages=${rows.length} errors=${rows.filter((r) => r.error).length} serious_or_critical=${bad.length} other_violations=${other.length}`);
for (const b of bad.slice(0, 25)) console.log(`  ${b.impact} ${b.id} ${b.surface}@${b.width} x${b.nodes} ${b.sample}`);
for (const o of [...new Set(other)].slice(0, 25)) console.log(`  other ${o}`);
process.exit(bad.length || rows.some((r) => r.error) ? 1 : 0);
