#!/usr/bin/env node
/**
 * Performance measurement against a local production build (design directive 6.9).
 *
 *   npm run build
 *   node scripts/perf.mjs                 starts `next start` on PERF_PORT (default 3122), measures, stops it
 *   BASE_URL=http://localhost:3122 node scripts/perf.mjs   measure a server that is already running
 *
 * For each route it reports, as the median of RUNS cold loads (fresh context each time) on a throttled
 * profile (CDP: 1.6 Mbps down, 750 kbps up, 150 ms RTT, 4x CPU slowdown):
 *   gzipJsKB   sum of transferSize over every script resource (bytes on the wire as served, gzip, headers included)
 *   fcpMs, lcpMs, cls, tbtMs  from PerformanceObserver (paint, largest-contentful-paint, layout-shift,
 *              longtask)
 *   ttiApproxMs  end of the last long task after FCP, or FCP when there are none. This approximates
 *              time to interactive; it is not Lighthouse's TTI.
 * Writes docs/evidence/perf/perf.<date>.json and prints a table. One Chromium, closed at the end.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";

const RUNS = Number(process.env.PERF_RUNS ?? 5);
const port = process.env.PERF_PORT ?? "3122";
const external = process.env.BASE_URL;
const base = external ?? `http://localhost:${port}`;
const routes = (process.env.PERF_ROUTES ?? "/,/oral,/privacy").split(",");
const date = new Date().toISOString().slice(0, 10);

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

let server = null;
if (!external) {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", port], { stdio: "ignore", windowsHide: true });
  await waitFor(base + "/api/health");
}

const observers = () => {
  window.__perf = { lcp: 0, cls: 0, fcp: 0, longtasks: [] };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime;
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.longtasks.push([e.startTime, e.duration]);
  }).observe({ type: "longtask", buffered: true });
};

const browser = await chromium.launch();
const results = {};
try {
  for (const route of routes) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.addInitScript(observers);
      await page.goto(base + route, { waitUntil: "load", timeout: 90000 });
      // Not networkidle: Next prefetches the linked dynamic routes and that never goes quiet under throttling.
      await page.waitForTimeout(3500);
      const p = await page.evaluate(() => window.__perf);
      const tbt = p.longtasks.reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
      const lastEnd = p.longtasks.filter(([s]) => s > p.fcp).reduce((m, [s, d]) => Math.max(m, s + d), p.fcp);
      const res = await page.evaluate(() =>
        performance.getEntriesByType("resource").filter((r) => /\.js(\?|$)/.test(r.name) || r.initiatorType === "script").map((r) => r.transferSize)
      );
      const gz = res.reduce((a, b) => a + b, 0);
      const jsFiles = res.length;
      runs.push({ gzipJsKB: gz / 1024, jsFiles, fcpMs: p.fcp, lcpMs: p.lcp, cls: p.cls, tbtMs: tbt, ttiApproxMs: lastEnd });
      await ctx.close();
    }
    const m = (k) => median(runs.map((r) => r[k]));
    results[route] = {
      n: RUNS,
      gzipJsKB: +m("gzipJsKB").toFixed(1),
      jsFiles: m("jsFiles"),
      fcpMs: Math.round(m("fcpMs")),
      lcpMs: Math.round(m("lcpMs")),
      cls: +m("cls").toFixed(4),
      tbtMs: Math.round(m("tbtMs")),
      ttiApproxMs: Math.round(m("ttiApproxMs")),
      runs,
    };
  }
} finally {
  await browser.close();
  if (server) server.kill();
}

const out = { date, profile: "CDP 1.6 Mbps down, 750 kbps up, 150 ms RTT, 4x CPU slowdown, 390x844", base, results };
fs.mkdirSync("docs/evidence/perf", { recursive: true });
fs.writeFileSync(`docs/evidence/perf/perf.${date}.json`, JSON.stringify(out, null, 2) + "\n", "utf8");
console.table(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { n: v.n, gzipJsKB: v.gzipJsKB, jsFiles: v.jsFiles, fcpMs: v.fcpMs, lcpMs: v.lcpMs, cls: v.cls, tbtMs: v.tbtMs, ttiApproxMs: v.ttiApproxMs }])));
const root = results["/"];
console.log(`budget: / gzip JS ${root.gzipJsKB} KB (limit 150), CLS ${root.cls} (limit 0.02) -> ${root.gzipJsKB < 150 && root.cls < 0.02 ? "pass" : "FAIL"}`);
process.exit(root.gzipJsKB < 150 && root.cls < 0.02 ? 0 : 1);
