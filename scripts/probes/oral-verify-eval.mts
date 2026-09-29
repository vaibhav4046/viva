/**
 * Live run of the verify_claim judge over the labelled claim set, through
 * VIVA's real provider chain. Records every raw model decision so the
 * committed test can replay the exact same decisions without a network call.
 *
 *   npx tsx --env-file=.env.local scripts/probes/oral-verify-eval.mts [--limit N] [--course id]
 *
 * Output: docs/evidence/probes/verify-claim-live-<date>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COURSES } from "../../src/lib/courses";
import { verifyClaim, type ClaimVerdict } from "../../src/lib/oral/verify-claim";
import { scoreVerdicts, type Verdict } from "../../src/lib/oral/verify-eval";
import { reasonObject } from "../../src/lib/ai/reason";
import { providerStatus } from "../../src/lib/ai/provider";

type Labelled = { id: string; kind: string; expected: Verdict; claim: string };
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const set = JSON.parse(readFileSync(root("fixtures/verify-claims/claims.json"), "utf8")) as { courses: Record<string, Labelled[]> };

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const only = arg("course");
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

type Row = {
  course: string; id: string; kind: string; claim: string; expected: Verdict;
  raw: { verdict: string; quote: string; passage_id: string; latencyMs: number } | null;
  final: ClaimVerdict;
};

const rows: Row[] = [];
for (const [courseId, claims] of Object.entries(set.courses)) {
  if (only && courseId !== only) continue;
  const chunks = COURSES[courseId].sources.flatMap((s) => s.chunks);
  for (const item of claims.slice(0, limit)) {
    let raw: Row["raw"] = null;
    const final = await verifyClaim(item.claim, chunks, async (input) => {
      const r = await reasonObject(input);
      if (r) raw = { verdict: r.value.verdict, quote: r.value.quote, passage_id: r.value.passage_id, latencyMs: r.latencyMs };
      return r;
    });
    rows.push({ course: courseId, id: item.id, kind: item.kind, claim: item.claim, expected: item.expected, raw, final });
    console.log(item.id, item.expected.padEnd(15), "->", final.verdict.padEnd(15), raw ? `raw=${(raw as NonNullable<Row["raw"]>).verdict}` : "raw=none", `${final.latency_ms}ms`);
    await sleep(300);
  }
}

const metrics = scoreVerdicts(rows.map((r) => ({ expected: r.expected, verdict: r.final.verdict })));
const latencies = rows.filter((r) => r.raw).map((r) => r.raw!.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] : null;
const date = new Date().toISOString().slice(0, 10);
const out = {
  measuredOn: new Date().toISOString(),
  what: "verify_claim judge over the labelled claim set, live provider chain, one call per claim",
  provider: providerStatus().model ?? "unknown",
  n: rows.length,
  modelCalls: latencies.length,
  latencyMs: { median: pct(0.5), p95: pct(0.95) },
  metrics,
  rows,
};
mkdirSync(root("docs/evidence/probes"), { recursive: true });
const file = root(`docs/evidence/probes/verify-claim-live-${date}${only || Number.isFinite(limit) ? "-partial" : ""}.json`);
writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
console.log("METRICS", JSON.stringify(metrics), "latency", JSON.stringify(out.latencyMs), "wrote", file);
