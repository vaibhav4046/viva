import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Academic Noir token guard.
 *
 * Two jobs:
 *  1. Pin the palette in src/app/globals.css to Academic Noir, and prove the
 *     two palettes it replaced (the light "paper" set and the neon "spectrum"
 *     set) have not crept back in.
 *  2. Recompute every text/background pair with the WCAG 2.x relative
 *     luminance formula and fail if any pair drops below 4.5:1. The ratios
 *     are computed from the values read out of the CSS, so token drift is
 *     caught rather than papered over.
 */

const CSS = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");

function cssVar(name: string): string {
  const match = CSS.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} is not defined in globals.css`);
  return match[1].trim();
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

/** WCAG 2.x contrast ratio. */
export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* ----------------------------- the palette ----------------------------- */

const PALETTE: Record<string, string> = {
  "color-obsidian": "#0b0b0c",
  "color-graphite": "#131417",
  "color-panel": "#191b1f",
  "color-hairline": "#262a31",
  "color-slate": "#3a3f47",
  "color-paper": "#f2f0ea",
  "color-mist": "#d3d1c9",
  "color-ash": "#a7abb6",
  "color-cognition": "#b8ff5a",
  "color-band-solid": "#b8ff5a",
  "color-band-getting": "#8fa2ff",
  "color-band-shaky": "#fbbf24",
  "color-band-mixed": "#ff8080",
  "color-band-notyet": "#a7abb6",
};

describe("Academic Noir palette", () => {
  it.each(Object.entries(PALETTE))("--%s is %s", (name, hex) => {
    expect(cssVar(name)).toBe(hex);
  });

  it("defines one band token per mastery word", () => {
    const bands = [...CSS.matchAll(/--color-band-([a-z]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(bands)).toEqual(new Set(["solid", "getting", "shaky", "mixed", "notyet"]));
  });

  it("has dropped the spectrum palette", () => {
    expect(CSS).not.toMatch(/--color-spectrum-/);
    expect(CSS).not.toMatch(/--grad-spec/);
  });

  it("has dropped the light paper palette", () => {
    expect(CSS).not.toMatch(/--color-paper-(surface|ink|lime|coral|hairline|caption|card)/);
  });

  it("has dropped the storage banner styles", () => {
    expect(CSS).not.toMatch(/storage-banner/);
  });
});

/* ------------------------------ contrast ------------------------------ */

const GROUNDS = [
  ["obsidian", PALETTE["color-obsidian"]],
  ["graphite", PALETTE["color-graphite"]],
  ["panel", PALETTE["color-panel"]],
] as const;

const FOREGROUNDS = [
  "color-paper",
  "color-mist",
  "color-ash",
  "color-cognition",
  "color-band-solid",
  "color-band-getting",
  "color-band-shaky",
  "color-band-mixed",
  "color-band-notyet",
] as const;

describe("contrast on every surface", () => {
  for (const [groundName, ground] of GROUNDS) {
    for (const fg of FOREGROUNDS) {
      it(`${fg} on ${groundName} clears 4.5:1`, () => {
        expect(contrast(PALETTE[fg], ground)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("obsidian text on the lime button clears 4.5:1", () => {
    expect(contrast(PALETTE["color-obsidian"], PALETTE["color-cognition"])).toBeGreaterThanOrEqual(4.5);
  });

  it("obsidian text on the paper button clears 4.5:1", () => {
    expect(contrast(PALETTE["color-obsidian"], PALETTE["color-paper"])).toBeGreaterThanOrEqual(4.5);
  });
});

/* -------------------------------- type -------------------------------- */

describe("type scale", () => {
  it("is 12 / 14 / 16 / 18 / 24 / 32 / 48", () => {
    const sizes = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"].map((k) => cssVar(`text-${k}`));
    expect(sizes).toEqual(["12px", "14px", "16px", "18px", "24px", "32px", "48px"]);
  });

  it("sets body to 16px and 1.55 line-height", () => {
    const body = CSS.match(/\bbody\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).toMatch(/font-size:\s*16px/);
    expect(body).toMatch(/line-height:\s*1\.55/);
  });
});
