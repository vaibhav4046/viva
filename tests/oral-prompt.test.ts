import { describe, expect, it } from "vitest";
import { ORAL_EXAMINER_RULES, ORAL_MAX_QUESTIONS, ORAL_PROMPT_VERSION } from "@/lib/oral/prompt";
import { toolDefsForWire } from "@/lib/oral/tools";

describe("examiner prompt", () => {
  it("has a dated version", () => {
    expect(ORAL_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("matches the reviewed snapshot for this version", () => {
    // A change here is a behaviour change: bump ORAL_PROMPT_VERSION and review the diff.
    expect({ version: ORAL_PROMPT_VERSION, text: ORAL_EXAMINER_RULES }).toMatchSnapshot();
  });

  it("enforces the pedagogy the spec lists", () => {
    const t = ORAL_EXAMINER_RULES;
    expect(t).toMatch(/one question at a time/i);
    expect(t).toMatch(/under about twenty-five words/i);
    expect(t).toMatch(/no markdown, no lists/i);
    expect(t).toMatch(/Only a contradicted verdict/);
    expect(t).toMatch(/say the page aloud/i);
    expect(t).toMatch(/restate the fact in their own words/i);
    expect(t).toMatch(/Never resume the interrupted sentence/);
    expect(t).toMatch(/weakest concept/i);
    expect(t).toMatch(/Alternate recall, why, and application/);
    expect(t).toMatch(/next_focus/);
    expect(t).toContain(`After ${ORAL_MAX_QUESTIONS} questions`);
    expect(t).toMatch(/never lecture/i);
  });

  it("only names tools the Voice Agent actually has", () => {
    const wire = new Set(toolDefsForWire().map((d) => d.name));
    for (const name of t(ORAL_EXAMINER_RULES)) expect(wire.has(name), name).toBe(true);
    expect(ORAL_EXAMINER_RULES).not.toMatch(/save_note|check_my_understanding|quote_my_material/);
  });

  it("uses no long dashes", () => {
    expect(ORAL_EXAMINER_RULES).not.toContain(String.fromCharCode(0x2014));
    expect(ORAL_EXAMINER_RULES).not.toContain(String.fromCharCode(0x2013));
  });
});

/** Tool-shaped identifiers mentioned in the prompt. */
function t(text: string): string[] {
  return [...new Set(text.match(/\b(?:verify_claim|grade_my_answer|search_my_material|save_note|quote_my_material|check_my_understanding)\b/g) ?? [])];
}
