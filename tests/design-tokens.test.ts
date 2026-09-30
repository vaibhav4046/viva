import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Examiner's table token guard.
 *
 * Two jobs:
 *  1. Pin the palette in src/styles/tokens.css and the Tailwind bridge in
 *     src/app/globals.css, and prove the earlier palettes (dark Academic Noir,
 *     the neon "spectrum" set, the light "paper" set) have not crept back in.
 *  2. Recompute every text/surface pair with the WCAG 2.x relative luminance
 *     formula and fail if any pair drops below its minimum. The ratios are
 *     computed from the values read out of the CSS, so token drift is caught
 *     rather than papered over. scripts/check-contrast.mjs runs the same
 *     computation over design/contrast-pairs.json.
 */

const GLOBALS = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");
const TOKENS = readFileSync(fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)), "utf8");

function tokenVar(name: string): string {
  const match = TOKENS.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} is not defined in tokens.css`);
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
  canvas: "#F1EDE4",
  "surface-1": "#F8F5EE",
  "surface-2": "#E7E1D5",
  elevated: "#FBF9F4",
  "text-primary": "#1D1B18",
  "text-secondary": "#4A463F",
  "text-muted": "#625C52",
  primary: "#1F2A3A",
  "on-primary": "#F8F5EE",
  correction: "#A63A2B",
  danger: "#A63A2B",
  success: "#2B6B4A",
  warning: "#7A4F00",
  info: "#1F5F8B",
  "success-tint": "#E2EBDD",
  "correction-tint": "#F1DDD6",
  "warning-tint": "#F0E4C8",
  "info-tint": "#DDE8EE",
  "border-subtle": "#DDD6C8",
  border: "#CFC7B8",
  "border-strong": "#8C8475",
  "border-focus": "#1F5F8B",
  "border-error": "#A63A2B",
};

describe("Examiner's table palette", () => {
  it.each(Object.entries(PALETTE))("--%s is %s", (name, hex) => {
    expect(tokenVar(name).toUpperCase()).toBe(hex.toUpperCase());
  });

  it("uses the radius scale 2, 4, 6, 10 and a pill", () => {
    expect(["xs", "sm", "md", "lg", "pill"].map((k) => tokenVar(`radius-${k}`))).toEqual([
      "2px",
      "4px",
      "6px",
      "10px",
      "999px",
    ]);
  });

  it("has a 2px focus ring in the focus token", () => {
    expect(TOKENS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--border-focus\)/);
  });

  it("zeroes the motion durations under prefers-reduced-motion", () => {
    expect(TOKENS).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*--dur-fast:\s*0\.01ms/);
  });

  it("defines one band token per mastery word", () => {
    const bands = [...GLOBALS.matchAll(/--color-band-([a-z]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(bands)).toEqual(new Set(["solid", "getting", "shaky", "mixed", "notyet"]));
  });

  it("has dropped every earlier palette", () => {
    expect(GLOBALS).not.toMatch(/--color-spectrum-/);
    expect(GLOBALS).not.toMatch(/--grad-spec/);
    expect(GLOBALS).not.toMatch(/--color-paper-(surface|ink|lime|coral|hairline|caption|card)/);
    expect(GLOBALS).not.toMatch(/storage-banner/);
    expect(GLOBALS + TOKENS).not.toMatch(/#b8ff5a|#0b0b0c|#131417/i);
  });

  it("carries no gradient, glass, or blur", () => {
    expect(GLOBALS + TOKENS).not.toMatch(/gradient\(|backdrop-filter|filter:\s*blur/);
  });
});

/* ------------------------------ contrast ------------------------------ */

const SURFACES = ["canvas", "surface-1", "surface-2", "elevated"] as const;
const TEXT = ["text-primary", "text-secondary", "text-muted", "primary", "correction", "success", "warning", "info"] as const;

describe("text contrast on every surface", () => {
  for (const surface of SURFACES) {
    for (const fg of TEXT) {
      it(`${fg} on ${surface} clears 4.5:1`, () => {
        expect(contrast(tokenVar(fg), tokenVar(surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it.each([
    ["success", "success-tint"],
    ["correction", "correction-tint"],
    ["warning", "warning-tint"],
    ["info", "info-tint"],
  ])("%s text on its tint clears 4.5:1", (fg, bg) => {
    expect(contrast(tokenVar(fg), tokenVar(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("on-primary text on the ink button clears 4.5:1, and on hover and active", () => {
    for (const bg of ["primary", "primary-hover", "primary-active"]) {
      expect(contrast(tokenVar("on-primary"), tokenVar(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("input edges (border-strong) clear 3:1 on the canvas and the field surface", () => {
    expect(contrast(tokenVar("border-strong"), tokenVar("canvas"))).toBeGreaterThanOrEqual(3);
    expect(contrast(tokenVar("border-strong"), tokenVar("elevated"))).toBeGreaterThanOrEqual(3);
  });

  it("the focus ring clears 3:1 on the canvas and on the primary button", () => {
    expect(contrast(tokenVar("border-focus"), tokenVar("canvas"))).toBeGreaterThanOrEqual(3);
    expect(contrast(tokenVar("border-focus"), tokenVar("surface-2"))).toBeGreaterThanOrEqual(3);
  });
});

/* -------------------------------- type -------------------------------- */

describe("type scale", () => {
  it("keeps the utility scale at 12 / 14 / 16 / 18 / 24 / 32 / 48", () => {
    const sizes = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"].map((k) => {
      const m = GLOBALS.match(new RegExp(`--text-${k}\\s*:\\s*([^;]+);`));
      return m?.[1].trim();
    });
    expect(sizes).toEqual(["12px", "14px", "16px", "18px", "24px", "32px", "48px"]);
  });

  it("sets body to 1rem and 1.6 line-height", () => {
    expect(tokenVar("fs-body")).toBe("1rem");
    expect(tokenVar("lh-body")).toBe("1.6");
    const body = GLOBALS.match(/\bbody\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).toMatch(/font-size:\s*var\(--fs-body\)/);
    expect(body).toMatch(/line-height:\s*var\(--lh-body\)/);
  });

  it("names Newsreader for display, IBM Plex Sans for the interface and IBM Plex Mono for figures", () => {
    expect(tokenVar("font-display")).toMatch(/--font-newsreader/);
    expect(tokenVar("font-ui")).toMatch(/--font-plex-sans/);
    expect(tokenVar("font-mono")).toMatch(/--font-plex-mono/);
  });

  it("loads no default-AI font", () => {
    const layout = readFileSync(fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)), "utf8");
    expect(layout).not.toMatch(/\b(Inter|Geist|Space_Grotesk|Poppins|DM_Sans|Plus_Jakarta)/);
  });
});

/* ------------------------------ one verdict ----------------------------- */
/*
 * A marked answer carries exactly one band word, and the verdict chip is what
 * carries it. The blocks under the chip name PARTS of the answer, so a block
 * label that is also a band word reads as a second, competing verdict, which
 * is what "Partly there" over a red "MIXED UP" was. Same trap the Daily Path
 * fell into with "MISCONCEPTION", fixed the same way.
 */
describe("a card says one thing", () => {
  const BAND_WORDS = ["Solid", "Getting there", "Shaky", "Mixed up", "Not yet"];

  it("no result-block label is a mastery band word", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/components/ui/ResultBlock.tsx", import.meta.url)), "utf8");
    const labels = [...src.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    const collisions = labels.filter((l) => BAND_WORDS.some((w) => w.toLowerCase() === l.toLowerCase()));
    expect(collisions).toEqual([]);
  });

  it("no Daily Path segment label is a mastery band word either", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/components/today/SegmentCard.tsx", import.meta.url)), "utf8");
    const labels = [...src.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((l) => BAND_WORDS.some((w) => w.toLowerCase() === l.toLowerCase()))).toEqual([]);
  });
});
