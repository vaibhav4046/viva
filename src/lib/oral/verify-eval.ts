/**
 * Scoring for the labelled verify_claim set (fixtures/verify-claims/claims.json).
 * The set is small and hand written. These numbers describe that set only.
 */
export type Verdict = "supported" | "contradicted" | "not_in_material";

export type ScoredRow = { expected: Verdict; verdict: Verdict };

type Confusion = { tp: number; fp: number; fn: number; precision: number | null; recall: number | null };

export type EvalMetrics = {
  n: number;
  /** A supported verdict on a claim that is not supported by the material. Must be 0. */
  falseSupported: number;
  /** A contradicted verdict on a claim that is not contradicted by the material. */
  falseContradicted: number;
  /** Not-in-material verdicts on claims the material does settle (safe misses). */
  abstainedOnSettled: number;
  supported: Confusion;
  contradicted: Confusion;
};

const ratio = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 1000) / 1000);

function confusion(rows: ScoredRow[], label: Verdict): Confusion {
  const tp = rows.filter((r) => r.verdict === label && r.expected === label).length;
  const fp = rows.filter((r) => r.verdict === label && r.expected !== label).length;
  const fn = rows.filter((r) => r.verdict !== label && r.expected === label).length;
  return { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}

export function scoreVerdicts(rows: ScoredRow[]): EvalMetrics {
  return {
    n: rows.length,
    falseSupported: rows.filter((r) => r.verdict === "supported" && r.expected !== "supported").length,
    falseContradicted: rows.filter((r) => r.verdict === "contradicted" && r.expected !== "contradicted").length,
    abstainedOnSettled: rows.filter((r) => r.verdict === "not_in_material" && r.expected !== "not_in_material").length,
    supported: confusion(rows, "supported"),
    contradicted: confusion(rows, "contradicted"),
  };
}
