import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The review room's colours, held to WCAG AA as computed from the stylesheet
 * itself, and its design rules held to the written directive: no gradients as
 * decoration, no glow, no glass, no dot lattice, no sparkles.
 */
const CSS = readFileSync(fileURLToPath(new URL("../src/app/redteam/redteam.css", import.meta.url)), "utf8");
const SRC_DIR = fileURLToPath(new URL("../src/components/redteam/", import.meta.url));

const tok = (name: string): string => {
  const m = CSS.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`token --${name} missing`);
  return m[1];
};
const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lum = (hex: string) => {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => ch(parseInt(c.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const GRAPHITE = ["rt-g0", "rt-g1", "rt-g2", "rt-g3"].map(tok);
const PAPER = ["rt-paper", "rt-paper-2"].map(tok);

describe("review room contrast (WCAG AA, computed from redteam.css)", () => {
  it("text and secondary text on every graphite surface", () => {
    for (const bg of GRAPHITE) {
      expect(contrast(tok("rt-text"), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok("rt-text-2"), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("each verdict colour on every graphite surface", () => {
    for (const name of ["rt-supported", "rt-partial", "rt-contradicted", "rt-unsupported", "rt-unresolved"]) {
      for (const bg of GRAPHITE) expect(contrast(tok(name), bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ink on the document surface", () => {
    for (const bg of PAPER) {
      expect(contrast(tok("rt-ink"), bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(tok("rt-ink-2"), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ink on every review mark", () => {
    for (const name of ["rt-mark-supported", "rt-mark-contradicted", "rt-mark-partial", "rt-mark-asked"]) {
      expect(contrast(tok("rt-ink"), tok(name)), name).toBeGreaterThanOrEqual(7);
    }
  });

  it("the badge colours on the source and the focus rings", () => {
    for (const badge of ["#2f6b40", "#8a2c1c", "#7a5200"]) {
      expect(CSS).toContain(badge);
      expect(contrast(tok("rt-paper"), badge), badge).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast("#7a5200", tok("rt-paper"))).toBeGreaterThanOrEqual(4.5);
    for (const bg of GRAPHITE) expect(contrast(tok("rt-focus"), bg)).toBeGreaterThanOrEqual(3);
    expect(contrast("#8a5a00", tok("rt-paper"))).toBeGreaterThanOrEqual(3);
    expect(contrast("#7a2418", "#f8ddd5")).toBeGreaterThanOrEqual(4.5);
  });

  it("colour is never the only signal: every status has its own shape", () => {
    const shapes = [...CSS.matchAll(/\.rt-shape\[data-shape="(\w+)"\]/g)].map((m) => m[1]);
    expect(new Set(shapes)).toEqual(new Set(["solid", "half", "cross", "dashed", "ring"]));
  });
});

describe("anti-vibecode directive", () => {
  const banned: [RegExp, string][] = [
    [/backdrop-filter/i, "glassmorphism"],
    [/radial-gradient/i, "glowing orb"],
    [/conic-gradient/i, "decorative gradient"],
    [/box-shadow:[^;]*\b(?:blur|[1-9]\d)px[^;]*rgba?\(/i, "soft glow shadow"],
    [/text-shadow/i, "glow text"],
    [/background-size:\s*\d+px\s+\d+px/i, "dot lattice"],
    [/filter:\s*blur/i, "blur"],
    [/#(?:7c3aed|8b5cf6|a855f7|6d28d9|4c1d95)/i, "AI purple"],
  ];
  for (const [re, why] of banned) {
    it(`redteam.css has no ${why}`, () => {
      expect(CSS).not.toMatch(re);
    });
  }

  it("has no linear-gradient except the two-stop hard split that draws the Partial shape", () => {
    const grads = CSS.match(/linear-gradient\((?:[^()]|\([^)]*\))*\)/g) ?? [];
    for (const g of grads) expect(g).toMatch(/90deg, var\(--c\) 50%, transparent 50%/);
  });

  it("components use no emoji, no sparkle, and no icon library", async () => {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(SRC_DIR)) {
      const src = readFileSync(SRC_DIR + f, "utf8");
      expect(src, f).not.toMatch(/lucide-react/);
      expect(src, f).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(src, f).not.toMatch(/sparkle/i);
    }
  });

  it("every animation is switched off under prefers-reduced-motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    // Every keyframe animation is causal: a mark drawn, a claim flagged. Nothing loops.
    expect(CSS).not.toMatch(/animation:[^;]*infinite/);
  });
});
