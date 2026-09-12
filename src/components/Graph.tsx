"use client";
import { motion } from "motion/react";
import { CONCEPTS } from "@/lib/course";
import { masteryState } from "@/lib/mastery";
import type { ConceptMastery } from "@/lib/types";

const STATE_COLOR: Record<string, string> = {
  strong: "var(--color-cognition)",
  developing: "var(--color-signal)",
  uncertain: "var(--color-ash)",
  misconception: "var(--color-coral)",
  unseen: "var(--color-slate)",
};

const LEGEND: { key: string; label: string }[] = [
  { key: "strong", label: "strong" },
  { key: "developing", label: "developing" },
  { key: "uncertain", label: "uncertain" },
  { key: "misconception", label: "misconception" },
  { key: "unseen", label: "unseen" },
];

/** Deterministic SVG knowledge graph — nodes are concepts, state from mastery. */
export function Graph({
  mastery,
  selected,
  onSelect,
  concepts = CONCEPTS,
}: {
  mastery: Record<string, ConceptMastery>;
  selected?: string | null;
  onSelect?: (id: string) => void;
  /** Course concepts; defaults to the default lab (kept for older callers). */
  concepts?: { id: string; name: string; related?: string[] }[];
}) {
  // Fixed layout: no randomness, stable across renders. Edge nodes sit inside
  // the 400-unit viewBox so long labels never clip at 380px card width.
  const pos: Record<string, [number, number]> = {
    c_self_attention: [200, 86],
    c_qkv: [92, 190],
    c_position: [308, 190],
    c_multihead: [200, 268],
    c_backprop: [74, 300],
    c_policy_value: [318, 300],
  };
  // Non-Transformer labs get a deterministic circle: same input → same layout.
  const unknown = concepts.map((c) => c.id).filter((id) => !pos[id]);
  unknown.forEach((id, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / unknown.length;
    pos[id] = [Math.round(200 + 118 * Math.cos(angle)), Math.round(176 + 118 * Math.sin(angle))];
  });
  const ids = new Set(concepts.map((c) => c.id));
  const seenEdges = new Set<string>();
  const edges: [string, string][] = [];
  for (const c of concepts) {
    for (const r of c.related ?? []) {
      if (!ids.has(r)) continue;
      const key = [c.id, r].sort().join("|");
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push([c.id, r]);
    }
  }
  const interactiveAll = Boolean(onSelect);
  return (
    <div
      className="surface-card p-4"
      role={interactiveAll ? "group" : "img"}
      aria-label="Misconception graph: concept mastery estimates"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="heading text-base">Misconception Graph</h3>
        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>VIVA estimate</span>
      </div>
      <svg viewBox="0 0 400 352" className="w-full" role="presentation">
        <defs>
          {/* DESIGN_V2 §4 — selected node ring only (violet → magenta → cyan). */}
          <linearGradient id="spectrum-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--color-spectrum-violet)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--color-coral)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-signal)" }} />
          </linearGradient>
        </defs>
        {edges.map(([a, b]) => {
          const [x1, y1] = pos[a];
          const [x2, y2] = pos[b];
          return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-hairline)" strokeWidth={1.5} />;
        })}
        {concepts.map((c) => {
          const m = mastery[c.id];
          const pct = m ? Math.round(m.mastery * 100) : 0;
          const st = m ? masteryState(m.mastery) : "unseen";
          const [x, y] = pos[c.id] ?? [200, 170];
          const col = STATE_COLOR[st];
          const isSel = selected === c.id;
          const interactive = Boolean(onSelect);
          return (
            <g
              key={c.id}
              className={interactive ? "graph-node" : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `${c.name}: ${pct}% mastery, ${st}${isSel ? ", selected" : ""}` : undefined}
              aria-pressed={interactive ? isSel : undefined}
              onClick={interactive ? () => onSelect?.(c.id) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(c.id);
                      }
                    }
                  : undefined
              }
              style={{ cursor: interactive ? "pointer" : "default" }}
            >
              <circle cx={x} cy={y} r={34} fill="transparent" />
              {/* M9 — selected glow: opacity 0→1 160ms, transform-free. */}
              <motion.circle
                cx={x} cy={y} r={34}
                fill="none" stroke="url(#spectrum-ring)" strokeWidth={1.5}
                initial={false}
                animate={{ opacity: isSel ? 0.7 : 0 }}
                transition={{ duration: 0.16 }}
                style={{ pointerEvents: "none" }}
              />
              <motion.circle
                cx={x} cy={y} r={isSel ? 30 : 24}
                fill="none" stroke={isSel ? "url(#spectrum-ring)" : col} strokeWidth={isSel ? 3 : 2}
                initial={false}
                animate={{ r: isSel ? 30 : 24 }}
                transition={{ type: "spring", stiffness: 300, damping: 22 }}
              />
              <circle cx={x} cy={y} r={5} fill={col} />
              <text x={x} y={y - 36} textAnchor="middle" fill="var(--color-paper)" fontSize={12} fontWeight={600}>{c.name}</text>
              <text x={x} y={y + 42} textAnchor="middle" fill={col} fontSize={11} fontFamily="monospace">
                {pct}%{st === "misconception" ? " ⚠" : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mono mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--color-ash)" }}>
        {LEGEND.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: STATE_COLOR[l.key] }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
