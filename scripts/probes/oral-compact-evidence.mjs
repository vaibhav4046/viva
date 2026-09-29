// Shrinks the raw traces in docs/evidence/probes/oral-live-*.json: per-chunk audio and
// transcript-delta rows are replaced by one counting row per kind. Every measured
// number (metrics, summary) is untouched; the probe applies the same compaction at write time.
//   node scripts/probes/oral-compact-evidence.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "docs/evidence/probes";
const NOISY = (e) => e.kind === "audio.play" || e.kind === "audio.drop" || e.type === "reply.audio" || e.type === "transcript.agent.delta";
const label = (e) => (e.kind === "ws.recv" ? `ws.recv ${e.type}` : e.kind);

export function compactTrace(rows) {
  const out = [];
  const groups = new Map();
  for (const e of rows) {
    if (!NOISY(e)) { out.push(e); continue; }
    const key = label(e);
    const g = groups.get(key) ?? { ms: e.ms, kind: "summary", of: key, count: 0, firstMs: e.ms, lastMs: e.ms };
    g.count += 1; g.lastMs = e.ms;
    groups.set(key, g);
  }
  return [...out, ...groups.values()].sort((a, b) => a.ms - b.ms);
}

if (process.argv[1] && process.argv[1].endsWith("oral-compact-evidence.mjs")) {
  for (const f of readdirSync(dir).filter((n) => /^oral-live-.*\.json$/.test(n))) {
    const p = join(dir, f);
    const ev = JSON.parse(readFileSync(p, "utf8"));
    let changed = false;
    for (const r of ev.results ?? []) {
      const t = r.notes?.trace;
      if (Array.isArray(t) && t.some(NOISY)) { r.notes.trace = compactTrace(t); changed = true; }
    }
    if (changed) { ev.traceNote = "per-chunk audio and transcript-delta rows are collapsed into summary rows (count, first and last ms); metrics are unchanged"; writeFileSync(p, JSON.stringify(ev, null, 2), "utf8"); console.log("compacted", f); }
  }
}
