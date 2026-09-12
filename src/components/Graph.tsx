"use client";
import { m, useReducedMotion } from "motion/react";
import { CONCEPTS } from "@/lib/course";
import { GENTLE } from "@/lib/motion";
import { BAND_COLOR, BAND_LABEL, BAND_ORDER, bandFor } from "@/components/bands";
import type { ConceptMastery } from "@/lib/types";

/**
 * Your map: one node per concept, coloured and labelled by band.
 *
 * Layout is fixed, not force-directed — the same subject always draws the
 * same shape, so a node moving means the student moved, not the renderer.
 * Every node prints its band in words underneath, so the colour is a second
 * signal rather than the only one.
 */
export function Graph({
  mastery,
  selected,
  onSelect,
  concepts = CONCEPTS,
  /** null when the page's own H1 already says "Your map". */
  title = "Your map",
}: {
  mastery: Record<string, ConceptMastery>;
  selected?: string | null;
  onSelect?: (id: string) => void;
  concepts?: { id: string; name: string; related?: string[] }[];
  title?: string | null;
}) {
  const reduced = useReducedMotion();

  // Deterministic circle: same concept list in, same picture out.
  const pos: Record<string, [number, number]> = {};
  concepts.forEach((c, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(1, concepts.length);
    pos[c.id] = [Math.round(220 + 130 * Math.cos(angle)), Math.round(190 + 118 * Math.sin(angle))];
  });

  // Names are the learner's, not ours, so they can be any length. Trim the
  // drawn label and keep the whole thing in the accessible name and a title.
  const short = (name: string) => (name.length > 17 ? `${name.slice(0, 16)}…` : name);

  const ids = new Set(concepts.map((c) => c.id));
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const c of concepts) {
    for (const r of c.related ?? []) {
      if (!ids.has(r)) continue;
      const key = [c.id, r].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([c.id, r]);
    }
  }

  const interactive = Boolean(onSelect);

  return (
    <div className="surface-card p-4" role={interactive ? "group" : "img"} aria-label="Your map of this subject">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        {title ? <h3 className="heading text-base">{title}</h3> : <span />}
        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
          {concepts.length} concepts
        </span>
      </div>

      <svg viewBox="0 0 440 384" className="w-full" role="presentation">
        {edges.map(([a, b]) => {
          const [x1, y1] = pos[a];
          const [x2, y2] = pos[b];
          return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-hairline)" strokeWidth={1.5} />;
        })}

        {concepts.map((c) => {
          const m0 = mastery[c.id];
          const band = bandFor(m0?.mastery, Boolean(m0 && m0.exposureCount > 0));
          const [x, y] = pos[c.id] ?? [220, 190];
          const color = BAND_COLOR[band];
          const isSel = selected === c.id;
          return (
            <g
              key={c.id}
              className={interactive ? "graph-node" : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `${c.name}: ${BAND_LABEL[band]}${isSel ? ", selected" : ""}` : undefined}
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
              {/* 44px hit area even though the drawn ring is smaller. */}
              <circle cx={x} cy={y} r={34} fill="transparent" />
              <m.circle
                cx={x}
                cy={y}
                r={24}
                fill="none"
                stroke={color}
                strokeWidth={isSel ? 3 : 2}
                initial={false}
                animate={reduced ? { opacity: 1 } : { scale: isSel ? 1.14 : 1 }}
                style={{ transformOrigin: `${x}px ${y}px` }}
                transition={GENTLE}
              />
              <circle cx={x} cy={y} r={5} fill={color} />
              <title>{`${c.name}: ${BAND_LABEL[band]}`}</title>
              <text x={x} y={y - 36} textAnchor="middle" fill="var(--color-paper)" fontSize={12} fontWeight={600}>
                {short(c.name)}
              </text>
              <text x={x} y={y + 42} textAnchor="middle" fill={color} fontSize={11} fontFamily="var(--font-mono)">
                {BAND_LABEL[band]}
              </text>
            </g>
          );
        })}
      </svg>

      <ul className="mono mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--color-ash)" }}>
        {BAND_ORDER.map((b) => (
          <li key={b} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: BAND_COLOR[b] }} />
            {BAND_LABEL[b]}
          </li>
        ))}
      </ul>
    </div>
  );
}
