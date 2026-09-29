import { describe, expect, it } from "vitest";
import { verifyClaim, quoteInPassage, quoteSpans } from "@/lib/oral/verify-claim";
import type { SourceChunk } from "@/lib/types";

const passage: SourceChunk = {
  id: "p19", sourceId: "s", ordinal: 0, locator: { page: 19 },
  text: "Multi-head attention runs several query-key-value computations in parallel. Different heads can capture different relationships.",
};
const claim = "Multi-head attention runs a single head over the input.";

describe("quote-checked oral verifier", () => {
  it("accepts only verbatim source words after whitespace normalization", () => {
    expect(quoteInPassage("runs several query-key-value computations\nin parallel", passage.text)).toBe(true);
    expect(quoteInPassage("runs one query-key-value computation", passage.text)).toBe(false);
    expect(quoteInPassage("several", passage.text)).toBe(false);
  });

  it("allows a contradiction only with a quote from the named passage", async () => {
    const decide = async () => ({ value: { verdict: "contradicted" as const, quote: "runs several query-key-value computations in parallel", passage_id: "p19" }, latencyMs: 1 });
    const result = await verifyClaim(claim, [passage], decide);
    expect(result).toMatchObject({ verdict: "contradicted", page: 19, passage_id: "p19", method: "llm", confirmed: false });
  });

  it("downgrades a fabricated quote even when the model says supported", async () => {
    const decide = async () => ({ value: { verdict: "supported" as const, quote: "runs a single head over the input", passage_id: "p19" }, latencyMs: 1 });
    const result = await verifyClaim(claim, [passage], decide);
    expect(result).toMatchObject({ verdict: "not_in_material", confirmed: false, quote: null });
  });

  it("never asserts support when no semantic provider is available", async () => {
    const result = await verifyClaim(claim, [passage], async () => null);
    expect(result).toMatchObject({ verdict: "not_in_material", method: "lexical", confirmed: false });
  });

  it('asks for a JSON object by name, because json_object mode returns HTTP 400 without the word JSON', async () => {
    let system = '';
    await verifyClaim(claim, [passage], async (input) => { system = input.system; return null; });
    expect(system).toMatch(/JSON object/);
    for (const key of ['verdict', 'quote', 'passage_id']) expect(system).toContain(key);
  });

  it("accepts an elided quote only when every piece is verbatim and in passage order, widened to whole sentences", () => {
    const text = passage.text;
    expect(quoteSpans("Multi-head attention runs several query-key-value ... Different heads can capture different relationships.", text)).toEqual([
      "Multi-head attention runs several query-key-value computations in parallel.",
      "Different heads can capture different relationships.",
    ]);
    expect(quoteSpans("Different heads can capture different relationships. ... Multi-head attention runs several query-key-value", text)).toBeNull();
    expect(quoteSpans("Multi-head attention runs several query-key-value ... and one head is enough for all of it", text)).toBeNull();
    expect(quoteSpans("...", text)).toBeNull();
  });

  it("passes the named concept to the judge so a spoken \"it\" has a subject", async () => {
    let user = "";
    await verifyClaim("it runs a single head over the input", [passage], async (input) => { user = input.user; return null; }, "multi-head attention");
    expect(JSON.parse(user).claim).toBe("multi-head attention: it runs a single head over the input");
  });
});
