import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the pre-hydration typing bug.
 *
 * The typed box (`#viva-type`) is server-rendered, so a student can type into
 * it before React hydrates. When the field was controlled, hydration
 * reconciled `value=""` over the live DOM node and silently wiped whatever
 * had been typed; Send then posted an empty string. Reproduced 4/4 on a
 * production build.
 *
 * The field is now uncontrolled — the DOM owns the value and submit reads it
 * off the ref — so hydration has nothing to overwrite. Browser-level proof
 * lives in scripts/e2e-golden.py ("pre-hydration typing survives"); this test
 * is the cheap guard that stops the controlled version coming back.
 */

const SRC = readFileSync(fileURLToPath(new URL("../src/components/TypedInput.tsx", import.meta.url)), "utf8");

/** Just the JSX attributes of the <input>, so the guard can't be fooled by
 * a `value` appearing elsewhere in the file (e.g. inside a comment). */
function inputAttributes(): string {
  const match = SRC.match(/<input\b([\s\S]*?)\/>/);
  if (!match) throw new Error("TypedInput no longer renders an <input>");
  return match[1];
}

describe("typed box is hydration-safe", () => {
  it("renders the input with the id the rest of the app targets", () => {
    expect(inputAttributes()).toMatch(/id="viva-type"/);
  });

  it("is uncontrolled: no value binding for hydration to overwrite", () => {
    const attrs = inputAttributes();
    expect(attrs).not.toMatch(/\bvalue=\{/);
    expect(attrs).toMatch(/\bdefaultValue=""/);
  });

  it("keeps no React state for the field's text", () => {
    expect(SRC).not.toMatch(/useState/);
  });

  it("reads the value off the DOM node when submitting", () => {
    expect(SRC).toMatch(/inputRef\.current[\s\S]{0,80}\.value/);
  });
});
