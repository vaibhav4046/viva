import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COURSES } from "@/lib/courses";
import { verifyClaim, quoteSpans } from "@/lib/oral/verify-claim";
import { scoreVerdicts, type Verdict } from "@/lib/oral/verify-eval";

/**
 * The labelled claim set (fixtures/verify-claims/claims.json, 54 hand-written
 * claims over the two bundled courses) replayed against the model decisions
 * recorded from a live run (docs/evidence/probes/verify-claim-live-*.json).
 * The replay runs the real verifyClaim, so the code that decides what may be
 * called supported is what is tested. It says nothing about model quality on
 * claims outside this set.
 */
type Labelled = { id: string; kind: string; expected: Verdict; claim: string };
type Row = { course: string; id: string; claim: string; expected: Verdict; raw: { verdict: Verdict; quote: string; passage_id: string; latencyMs: number } | null };

const claims = JSON.parse(readFileSync(join(process.cwd(), "fixtures/verify-claims/claims.json"), "utf8")) as { courses: Record<string, Labelled[]> };
const evidenceDir = join(process.cwd(), "docs/evidence/probes");
const evidenceFile = readdirSync(evidenceDir).filter((f) => /^verify-claim-live-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1)!;
const evidence = JSON.parse(readFileSync(join(evidenceDir, evidenceFile), "utf8")) as { rows: Row[]; metrics: ReturnType<typeof scoreVerdicts> };
const chunksOf = (course: string) => COURSES[course].sources.flatMap((s) => s.chunks);

const replay = (rows: Row[], tamper?: (raw: NonNullable<Row["raw"]>) => NonNullable<Row["raw"]>) =>
  Promise.all(rows.map(async (row) => {
    const decide = async () => (row.raw ? { value: tamper ? tamper(row.raw) : row.raw, latencyMs: row.raw.latencyMs } : null);
    const final = await verifyClaim(row.claim, chunksOf(row.course), decide as never);
    return { row, final };
  }));

describe("labelled claim set", () => {
  it("has at least 20 claims per course covering every kind", () => {
    for (const [course, list] of Object.entries(claims.courses)) {
      expect(list.length, course).toBeGreaterThanOrEqual(20);
      const kinds = new Set(list.map((c) => c.kind));
      for (const k of ["true_paraphrase", "shipped_misconception", "paraphrased_misconception", "false_real_vocabulary", "not_in_material"]) expect(kinds.has(k), `${course} ${k}`).toBe(true);
    }
  });

  it("includes the exact false claim the product is judged on", () => {
    const all = Object.values(claims.courses).flat();
    expect(all.some((c) => c.claim === "Multi-head attention runs a single head over the input." && c.expected === "contradicted")).toBe(true);
  });

  it("the recorded run covers every labelled claim exactly once", () => {
    const ids = new Set(Object.values(claims.courses).flat().map((c) => c.id));
    expect(evidence.rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

describe("replay of recorded decisions through verifyClaim", () => {
  it("returns zero false supported verdicts", async () => {
    const out = await replay(evidence.rows);
    const metrics = scoreVerdicts(out.map(({ row, final }) => ({ expected: row.expected, verdict: final.verdict })));
    expect(metrics.falseSupported).toBe(0);
    expect(metrics.falseContradicted).toBe(0);
    // evidence.metrics scores the raw model decisions. Today's code adds the
    // sentence-alignment, polarity and overlap checks (src/lib/oral/claim-guard.ts),
    // which can only turn a verdict into not_in_material, so the numbers below
    // are the same run replayed through those checks. Re-record after a live rerun.
    expect(metrics).toEqual({
      n: 54,
      falseSupported: 0,
      falseContradicted: 0,
      abstainedOnSettled: 7,
      supported: { tp: 17, fp: 0, fn: 2, precision: 1, recall: 0.895 },
      contradicted: { tp: 22, fp: 0, fn: 5, precision: 1, recall: 0.815 },
    });
    expect(metrics.supported.tp).toBeLessThanOrEqual(evidence.metrics.supported.tp);
  });

  it("never turns one decisive verdict into the other, only into not_in_material", async () => {
    const out = await replay(evidence.rows);
    for (const { row, final } of out) {
      if (!row.raw) continue;
      expect([row.raw.verdict, "not_in_material"], row.id).toContain(final.verdict);
    }
  });

  it("only ever cites text that is verbatim in the named passage", async () => {
    const out = await replay(evidence.rows);
    let cited = 0;
    for (const { row, final } of out) {
      if (final.verdict === "not_in_material") continue;
      cited++;
      const passage = chunksOf(row.course).find((c) => c.id === final.passage_id)!;
      expect(quoteSpans(final.quote!, passage.text), row.id).not.toBeNull();
      expect(final.quote_spans.length, row.id).toBeGreaterThan(0);
      expect(final.page, row.id).toBe(passage.locator.page);
    }
    expect(cited).toBeGreaterThan(30);
  });
});

describe("mutation: a model that fabricates its quote is caught", () => {
  it("downgrades every cited verdict when one word of the quote is changed", async () => {
    const cited = evidence.rows.filter((r) => r.raw && r.raw.verdict !== "not_in_material");
    const out = await replay(cited, (raw) => ({ ...raw, quote: raw.quote.replace(/\b(\w{5,})\b/, "fabricated") }));
    expect(out.length).toBeGreaterThan(30);
    for (const { row, final } of out) expect(final.verdict, row.id).toBe("not_in_material");
  });

  it("downgrades a supported verdict whose quote is the learner's own claim", async () => {
    const out = await replay(evidence.rows, () => ({ verdict: "supported", quote: "", passage_id: "ch_mh_1", latencyMs: 1 }));
    const bad = out.filter(({ row }) => row.claim.length >= 12).map(({ row, final }) => ({ id: row.id, ...final }));
    // An empty quote, or the claim text, is never in a passage: nothing may come back supported.
    expect(bad.filter((b) => b.verdict === "supported")).toEqual([]);
    const echo = await replay(evidence.rows, (raw) => ({ ...raw, verdict: "supported", quote: "PLACEHOLDER" }));
    expect(echo.filter(({ final }) => final.verdict === "supported")).toEqual([]);
  });

  it("downgrades a real quote attributed to a passage it is not in", async () => {
    const row = evidence.rows.find((r) => r.id === "T17")!;
    const out = await replay([row], (raw) => ({ ...raw, passage_id: raw.passage_id === "ch_mh_1" ? "ch_mh_2" : "ch_mh_1" }));
    expect(out[0].final.verdict).toBe("not_in_material");
  });
});
