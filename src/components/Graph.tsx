"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import { GENTLE } from "@/lib/motion";
import { BAND_COLOR, BAND_LABEL, BAND_ORDER, bandFor, type BandKey } from "@/components/bands";
import type { ConceptMastery } from "@/lib/types";

/**
 * Your map: one node per concept, coloured and labelled by band.
 *
 * The band word is the reason colour is never the only signal, so the word has
 * to be readable at the width the map is actually given. A fixed `viewBox`
 * scaled by `w-full` cannot promise that: the scale factor is the container
 * width over the viewBox width, so the same `fontSize={12}` rendered at 7.8 px
 * in the 286 px rail on /study, 8.8 px on a phone and 18.8 px on /map at 1440.
 * One font-size can be right for one of those, never all three.
 *
 * So the drawing is measured instead of scaled. The viewBox is set to the
 * container's own pixel width, which makes one user unit one CSS pixel — 12 is
 * 12 everywhere — and the ring geometry is derived from that width. Below the
 * width where a ring can hold a name and a band word without collapsing them
 * into each other, there is no honest ring to draw, so the same data renders as
 * a list of rows: the dot keeps the colour, the row keeps the word, and both
 * are real text at real size.
 */

/** Below this the ring cannot seat a two-line name without overlap. */
const RING_MIN_WIDTH = 400;
/** Horizontal room a wrapped name needs beside the ring, in px. */
const LABEL_BAND = 118;
/** Average advance of the label face at 12 px, for turning px into characters. */
const LABEL_CHAR_PX = 6.8;
const LABEL_MAX_CH = 17;
const LABEL_MIN_CH = 8;
/** Room above the top node for two label lines, and below the last for the word. */
const PAD_TOP = 72;
const PAD_BOTTOM = 76;
const LINE = 15;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** At most two lines of `max` characters, broken on a space, ellipsis past that. */
function labelLines(name: string, max: number): string[] {
  if (name.length <= max) return [name];
  const lines = [""];
  for (const word of name.split(" ")) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = word;
    else if (cur.length + 1 + word.length <= max) lines[lines.length - 1] = `${cur} ${word}`;
    else if (lines.length < 2) lines.push(word);
    else {
      lines[1] = `${lines[1].slice(0, max - 1)}…`;
      break;
    }
  }
  return lines;
}

/*
 * Edges are drawn before the nodes, so a label is already on top of a line in
 * z-order — but the line still shows through the gaps inside and between the
 * glyphs, and with the labels wrapping to two lines every one of the four edges
 * crossed a word. A stroke painted *under* the fill in the card colour knocks
 * the line out around each glyph, which costs two attributes instead of a
 * measured plate behind every <text>.
 */
const KNOCKOUT = {
  stroke: "var(--color-graphite)",
  strokeWidth: 3.5,
  strokeLinejoin: "round",
  paintOrder: "stroke",
} as const;

type Concept = { id: string; name: string; related?: string[] };

/** The ring, sized to the pixels it was handed. */
function ringLayout(width: number, count: number) {
  const rx = clamp((width - LABEL_BAND) / 2, 96, 220);
  const ry = rx * 0.9;
  const arc = count > 1 ? 2 * rx * Math.sin(Math.PI / count) : 2 * rx;
  return {
    cx: width / 2,
    cy: PAD_TOP + ry,
    rx,
    ry,
    height: Math.round(PAD_TOP + 2 * ry + PAD_BOTTOM),
    /** Names get the characters the gap between two nodes can actually hold. */
    maxCh: clamp(Math.round(arc / LABEL_CHAR_PX), LABEL_MIN_CH, LABEL_MAX_CH),
  };
}

function edgesOf(concepts: Concept[]): [string, string][] {
  const ids = new Set(concepts.map((c) => c.id));
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const c of concepts) {
    for (const r of c.related ?? []) {
      if (!ids.has(r)) continue;
      const key = [c.id, r].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([c.id, r]);
    }
  }
  return out;
}

export function Graph({
  mastery,
  selected,
  onSelect,
  concepts = [],
  /** null when the page's own H1 already says "Your map". */
  title = "Your map",
}: {
  mastery: Record<string, ConceptMastery>;
  selected?: string | null;
  onSelect?: (id: string) => void;
  concepts?: Concept[];
  title?: string | null;
}) {
  const reduced = useReducedMotion();
  const interactive = Boolean(onSelect);

  /*
   * Measured in a ref callback rather than an effect, so the first paint
   * already has the real width and the map does not swap shape under the
   * student. null is the server's answer, and it draws the ring at its widest
   * sensible size — the same markup hydration expects.
   */
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.round(el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const asRing = width === null || width >= RING_MIN_WIDTH;

  function bandOf(id: string) {
    const m0 = mastery[id];
    return bandFor(m0?.mastery, Boolean(m0 && m0.exposureCount > 0));
  }

  function pick(id: string) {
    onSelect?.(id);
  }

  return (
    <div className="surface-card p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        {title ? <h3 className="heading text-base">{title}</h3> : <span />}
        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
          {concepts.length} concepts
        </span>
      </div>

      <div ref={measure} className="min-w-0">
        {asRing ? (
          <Ring
            width={width ?? 440}
            concepts={concepts}
            bandOf={bandOf}
            selected={selected ?? null}
            interactive={interactive}
            reduced={Boolean(reduced)}
            onSelect={pick}
          />
        ) : (
          <Rows
            concepts={concepts}
            bandOf={bandOf}
            selected={selected ?? null}
            interactive={interactive}
            onSelect={pick}
          />
        )}
      </div>

      <ul className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--color-ash)" }}>
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

/** The circle. One user unit is one CSS pixel, so 12 px of type is 12 px. */
function Ring({
  width,
  concepts,
  bandOf,
  selected,
  interactive,
  reduced,
  onSelect,
}: {
  width: number;
  concepts: Concept[];
  bandOf: (id: string) => BandKey;
  selected: string | null;
  interactive: boolean;
  reduced: boolean;
  onSelect: (id: string) => void;
}) {
  const { cx, cy, rx, ry, height, maxCh } = ringLayout(width, Math.max(1, concepts.length));
  const pos: Record<string, [number, number]> = {};
  concepts.forEach((c, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(1, concepts.length);
    pos[c.id] = [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="w-full"
      role={interactive ? "group" : "img"}
      aria-label="Your map of this subject"
    >
      {edgesOf(concepts).map(([a, b]) => {
        const [x1, y1] = pos[a];
        const [x2, y2] = pos[b];
        return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-hairline)" strokeWidth={1.5} />;
      })}

      {concepts.map((c) => {
        const band = bandOf(c.id);
        const [x, y] = pos[c.id] ?? [cx, cy];
        const color = BAND_COLOR[band];
        const isSel = selected === c.id;
        const lines = labelLines(c.name, maxCh);
        return (
          <g
            key={c.id}
            className={interactive ? "graph-node" : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `${c.name}: ${BAND_LABEL[band]}${isSel ? ", selected" : ""}` : undefined}
            aria-pressed={interactive ? isSel : undefined}
            onClick={interactive ? () => onSelect(c.id) : undefined}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(c.id);
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
            <text
              x={x}
              y={y - 36 - (lines.length - 1) * LINE}
              textAnchor="middle"
              fill="var(--color-paper)"
              fontSize={12}
              fontWeight={600}
              {...KNOCKOUT}
            >
              {lines.map((line, i) => (
                <tspan key={line} x={x} dy={i === 0 ? 0 : LINE}>
                  {line}
                </tspan>
              ))}
            </text>
            <text x={x} y={y + 42} textAnchor="middle" fill={color} fontSize={12} fontFamily="var(--font-mono)" {...KNOCKOUT}>
              {BAND_LABEL[band]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The narrow map: the same concepts and the same bands, one row each.
 *
 * Rows instead of a ring because a 286 px rail cannot hold six names and six
 * band words around a circle at a size a person can read, and shrinking the
 * type until it fits is the thing that broke the guarantee in the first place.
 */
function Rows({
  concepts,
  bandOf,
  selected,
  interactive,
  onSelect,
}: {
  concepts: Concept[];
  bandOf: (id: string) => BandKey;
  selected: string | null;
  interactive: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="grid gap-1" aria-label="Your map of this subject">
      {concepts.map((c) => {
        const band = bandOf(c.id);
        const color = BAND_COLOR[band];
        const isSel = selected === c.id;
        const inner = (
          <>
            <i
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: color, boxShadow: isSel ? `0 0 0 3px color-mix(in oklab, ${color} 30%, transparent)` : undefined }}
            />
            <span className="min-w-0 flex-1 text-sm leading-snug" style={{ color: "var(--color-paper)" }}>
              {c.name}
            </span>
            <span className="mono shrink-0 text-xs" style={{ color }}>
              {BAND_LABEL[band]}
            </span>
          </>
        );
        const shape = "flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors";
        const tone = {
          borderColor: isSel ? color : "transparent",
          background: isSel ? "var(--color-panel)" : undefined,
        };
        return (
          <li key={c.id}>
            {interactive ? (
              <button
                type="button"
                className={`${shape} graph-node cursor-pointer hover:border-[var(--color-hairline)]`}
                style={tone}
                aria-pressed={isSel}
                onClick={() => onSelect(c.id)}
              >
                {inner}
              </button>
            ) : (
              <div className={shape} style={tone}>
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
