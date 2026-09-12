import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DESIGN_V2 §1 — Spectrum Noir token guard.
 *
 * Two jobs:
 *  1. Pin the spectrum tokens + recipes to their documented values in
 *     src/app/globals.css (append-only extension; existing tokens untouched).
 *  2. Recompute every documented text/background pair with the WCAG 2.x
 *     relative-luminance formula and fail if any pair drops below the value
 *     DESIGN_V2 §1c documents. The test computes from the hex pairs in the
 *     doc (not from the CSS), so token drift is caught even if both change.
 */

const CSS = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");

/* ------------------------------ helpers ------------------------------ */

function cssVar(name: string): string | null {
  const match = CSS.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(c)) throw new Error(`not a 6-digit hex: ${hex}`);
  const r = channel(parseInt(c.slice(0, 2), 16) / 255);
  const g = channel(parseInt(c.slice(2, 4), 16) / 255);
  const b = channel(parseInt(c.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, unrounded. */
export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const rounded = (a: string, b: string): number => Math.round(contrast(a, b) * 100) / 100;

/* --------------------------- §1 tokens exist --------------------------- */

const COLOR_TOKENS: Record<string, string> = {
  "color-spectrum-magenta": "#ff3ec8",
  "color-spectrum-violet": "#a855f7",
  "color-spectrum-red": "#ff453a",
  "color-spectrum-orange": "#ff9f0a",
  "color-spectrum-yellow": "#ffd60a",
  "color-spectrum-cyan": "#22d3ee",
  "color-spectrum-sky": "#64d2ff",
  "color-spectrum-violet-text": "#b98cff",
  "color-spectrum-ink": "#0b0a12",
  "color-spectrum-deep-violet": "#4c1d95",
  "color-spectrum-deep-magenta": "#831843",
  "color-spectrum-deep-rust": "#7c2d12",
  "color-spectrum-deep-cyan": "#164e63",
  "color-spectrum-paper-violet": "#6d28d9",
  "color-spectrum-paper-magenta": "#a21caf",
  "color-spectrum-paper-red": "#b3261e",
  "color-spectrum-paper-orange": "#9a3412",
  "color-spectrum-paper-cyan": "#0e7490",
};

const RECIPE_TOKENS = [
  "grad-spectrum",
  "grad-spec-warm",
  "grad-spec-cool",
  "grad-spec-ink",
  "grad-spec-paper",
  "grad-spec-veil",
  "glow-spectrum",
  "glow-warm",
  "shadow-lift",
  "dur-press",
  "dur-hover",
  "dur-enter",
  "dur-scene",
  "dur-cinema",
  "ease-snap",
  "ease-glide",
  "ease-pop",
  "ease-breathe",
  "ring-spectrum",
];

/*
 * The decorative sweep is cut from VIVA's own semantic triad, not the original
 * seven-stop rainbow. Section 18 of the product directive rules out generic
 * SaaS purple, and the landing rebuild pulled the whole app back onto
 * cognition lime -> signal blue -> misconception coral. The raw
 * --color-spectrum-* tokens above are still defined and still pinned by the
 * ledger; only the gradient recipes that paint rules, borders and dots moved.
 */
const SWEEP_STOPS = ["#b8ff5a", "#7c8cff", "#ff6b6b"];

describe("DESIGN_V2 spectrum tokens (globals.css)", () => {
  it("defines every documented spectrum colour token at its exact value", () => {
    const missing: string[] = [];
    for (const [token, hex] of Object.entries(COLOR_TOKENS)) {
      const value = cssVar(token)?.toLowerCase() ?? null;
      if (value !== hex) missing.push(`--${token}: expected ${hex}, got ${value ?? "missing"}`);
    }
    expect(missing).toEqual([]);
  });

  it("defines every documented recipe, glow and motion token", () => {
    const missing = RECIPE_TOKENS.filter((token) => cssVar(token) === null);
    expect(missing).toEqual([]);
  });

  it("cuts the sweep from the semantic triad and keeps the OKLCH upgrade", () => {
    const sweep = cssVar("grad-spectrum") ?? "";
    const absent = SWEEP_STOPS.filter((hex) => !sweep.toLowerCase().includes(hex));
    expect(absent).toEqual([]);
    // The rainbow must not creep back in.
    for (const banned of ["#ff3ec8", "#a855f7", "#ffd60a", "#22d3ee"]) {
      expect(sweep.toLowerCase()).not.toContain(banned);
    }
    expect(CSS).toMatch(/@supports\s*\(background:\s*linear-gradient\(in oklch/);
    expect(CSS).toContain("linear-gradient(115deg in oklch,");
  });
});

/* ------------------------ §1c contrast ledger ------------------------ */

const OBSIDIAN = "#080a0d";
const GRAPHITE = "#11151b";
const PAPER = "#f4f1e8";

type Pair = { label: string; text: string; bg: string; floor: number };

const LEDGER_PAIRS: Pair[] = [
  // Spectrum stops as text on obsidian #080A0D
  { label: "magenta on obsidian", text: "#ff3ec8", bg: OBSIDIAN, floor: 6.39 },
  { label: "violet on obsidian", text: "#a855f7", bg: OBSIDIAN, floor: 5.01 },
  { label: "red on obsidian", text: "#ff453a", bg: OBSIDIAN, floor: 5.82 },
  { label: "orange on obsidian", text: "#ff9f0a", bg: OBSIDIAN, floor: 9.64 },
  { label: "yellow on obsidian", text: "#ffd60a", bg: OBSIDIAN, floor: 14.04 },
  { label: "cyan on obsidian", text: "#22d3ee", bg: OBSIDIAN, floor: 10.97 },
  { label: "sky on obsidian", text: "#64d2ff", bg: OBSIDIAN, floor: 11.52 },
  { label: "violet-text on obsidian", text: "#b98cff", bg: OBSIDIAN, floor: 7.79 },
  // Spectrum stops as text on graphite #11151B
  { label: "magenta on graphite", text: "#ff3ec8", bg: GRAPHITE, floor: 5.91 },
  { label: "violet on graphite", text: "#a855f7", bg: GRAPHITE, floor: 4.63 },
  { label: "red on graphite", text: "#ff453a", bg: GRAPHITE, floor: 5.37 },
  { label: "orange on graphite", text: "#ff9f0a", bg: GRAPHITE, floor: 8.91 },
  { label: "yellow on graphite", text: "#ffd60a", bg: GRAPHITE, floor: 12.97 },
  { label: "cyan on graphite", text: "#22d3ee", bg: GRAPHITE, floor: 10.13 },
  { label: "sky on graphite", text: "#64d2ff", bg: GRAPHITE, floor: 10.64 },
  // Paper-safe stops as text on paper #F4F1E8
  { label: "paper-violet on paper", text: "#6d28d9", bg: PAPER, floor: 6.29 },
  { label: "paper-magenta on paper", text: "#a21caf", bg: PAPER, floor: 5.6 },
  { label: "paper-red on paper", text: "#b3261e", bg: PAPER, floor: 5.79 },
  { label: "paper-orange on paper", text: "#9a3412", bg: PAPER, floor: 6.47 },
  { label: "paper-cyan on paper", text: "#0e7490", bg: PAPER, floor: 4.74 },
  { label: "ink on paper", text: "#1f1b14", bg: PAPER, floor: 15.18 },
  { label: "caption on paper", text: "#5a5348", bg: PAPER, floor: 6.72 },
];

// Text-on-gradient law: only these pairings are legal.
const INK = "#1f1b14";
const ON_GRADIENT_PAIRS: Pair[] = [
  { label: "ink on spectrum yellow", text: INK, bg: "#ffd60a", floor: 12.14 },
  { label: "ink on spectrum orange", text: INK, bg: "#ff9f0a", floor: 8.34 },
  { label: "ink on spectrum sky", text: INK, bg: "#64d2ff", floor: 9.96 },
  { label: "ink on spectrum cyan", text: INK, bg: "#22d3ee", floor: 9.48 },
  { label: "ink on spectrum magenta", text: INK, bg: "#ff3ec8", floor: 5.53 },
  { label: "ink on spectrum red", text: INK, bg: "#ff453a", floor: 5.03 },
  { label: "paper on deep-violet", text: PAPER, bg: "#4c1d95", floor: 9.7 },
  { label: "paper on deep-rust (worst)", text: PAPER, bg: "#7c2d12", floor: 8.3 },
];

describe("DESIGN_V2 §1c contrast ledger (computed here, not copied)", () => {
  it("holds every documented text pair at or above its documented floor", () => {
    const failures: string[] = [];
    for (const p of LEDGER_PAIRS) {
      const actual = rounded(p.text, p.bg);
      if (actual < p.floor) failures.push(`${p.label}: ${actual} < ${p.floor}`);
    }
    expect(failures).toEqual([]);
  });

  it("every documented text pair clears WCAG AA (≥4.5:1) for normal text", () => {
    const below = LEDGER_PAIRS.filter((p) => contrast(p.text, p.bg) < 4.5).map((p) => p.label);
    expect(below).toEqual([]);
  });

  it("keeps the legal ink-on-gradient pairings at their documented floors", () => {
    const failures: string[] = [];
    for (const p of ON_GRADIENT_PAIRS) {
      const actual = rounded(p.text, p.bg);
      if (actual < p.floor) failures.push(`${p.label}: ${actual} < ${p.floor}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps ink off violet — the documented illegal pairing stays < 4.5:1", () => {
    expect(rounded(INK, "#a855f7")).toBeLessThan(4.5);
  });

  it("keeps the deep gradient floor ≥ 8:1 for paper text at every stop", () => {
    const stops = ["#4c1d95", "#831843", "#7c2d12"];
    const failures = stops
      .map((stop) => ({ stop, ratio: contrast(PAPER, stop) }))
      .filter(({ ratio }) => ratio < 8);
    expect(failures).toEqual([]);
  });

  it("documents the paper-safe rule recipe stops (all AA on paper)", () => {
    const rule = cssVar("grad-spec-paper") ?? "";
    const stops = ["#6d28d9", "#a21caf", "#b3261e", "#9a3412", "#0e7490"];
    expect(stops.filter((hex) => !rule.toLowerCase().includes(hex))).toEqual([]);
    expect(rounded("#6d28d9", PAPER)).toBeGreaterThanOrEqual(6.29);
    expect(rounded("#0e7490", PAPER)).toBeGreaterThanOrEqual(4.74);
  });
});
