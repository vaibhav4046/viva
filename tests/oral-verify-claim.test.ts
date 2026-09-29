import { describe, expect, it } from "vitest";
import { verifyClaim, quoteInPassage } from "@/lib/oral/verify-claim";
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
});
