#!/usr/bin/env node
/**
 * WCAG 2.x contrast check over design/contrast-pairs.json.
 *
 *   node scripts/check-contrast.mjs               check every pair against src/styles/tokens.css
 *   node scripts/check-contrast.mjs --self-test   prove the checker fails a pair that should fail
 *
 * A pair is { fg, bg, min, use }: token names (with or without the leading --), the minimum ratio
 * (4.5 for text, 3 for UI edges and the focus ring) and where the pair is used. If a pair fails,
 * change the token, not the rule. Exit 1 on any failure.
 */
import fs from "node:fs";

const tokens = {};
for (const m of fs.readFileSync("src/styles/tokens.css", "utf8").matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) tokens[m[1]] = m[2];

const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const name = (t) => t.replace(/^--/, "");
function check(pairs) {
  return pairs.map((p) => {
    const fg = tokens[name(p.fg)];
    const bg = tokens[name(p.bg)];
    if (!fg || !bg) return { ...p, ratio: NaN, ok: false, error: `unknown token ${!fg ? p.fg : p.bg}` };
    const r = ratio(fg, bg);
    return { ...p, ratio: r, ok: r >= p.min };
  });
}

if (process.argv.includes("--self-test")) {
  const bad = check([{ fg: "--text-muted", bg: "--text-primary", min: 4.5, use: "self-test" }]);
  const good = check([{ fg: "--text-primary", bg: "--canvas", min: 4.5, use: "self-test" }]);
  const ok = bad[0].ok === false && good[0].ok === true;
  console.log(`self-test: text-muted on text-primary = ${bad[0].ratio.toFixed(2)} (must fail), text-primary on canvas = ${good[0].ratio.toFixed(2)} (must pass)`);
  console.log(ok ? "self-test: pass" : "self-test: FAIL");
  process.exit(ok ? 0 : 1);
}

const pairs = JSON.parse(fs.readFileSync("design/contrast-pairs.json", "utf8"));
const results = check(pairs);
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  if (!r.ok || process.argv.includes("--verbose")) console.log(`${r.ok ? "pass" : "FAIL"} ${r.ratio.toFixed(2)} (min ${r.min}) ${r.fg} on ${r.bg}: ${r.use}${r.error ? " " + r.error : ""}`);
}
console.log(`check-contrast: ${results.length} pairs, ${failed} failing, lowest ratio ${Math.min(...results.map((r) => r.ratio)).toFixed(2)}`);
process.exit(failed ? 1 : 0);
