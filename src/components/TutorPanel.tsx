"use client";

const VERDICT: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-band-solid)", label: "Correct" },
  partial: { color: "var(--color-band-getting)", label: "Partly there" },
  incorrect: { color: "var(--color-band-mixed)", label: "Mixed up" },
};

/**
 * What VIVA said back.
 *
 * Citations link to the passage they came from, and they carry the number the
 * source rail gives that passage — not a per-reply counter.
 *
 * The counter was the bug a student caught: every reply cited "Passage 1" and
 * "Passage 2" while the rail called the same two paragraphs "Passage 5" and
 * "Passage 6", so clicking Passage 1 landed on Passage 6 and the one genuinely
 * trustworthy mechanism in the product looked hardcoded. `passageIds` is the
 * rail's own order; the chip reads its index out of that.
 */
export function TutorPanel({
  text,
  evidenceIds,
  passageIds = [],
  strategy,
}: {
  text: string | null;
  evidenceIds: string[];
  /** Every passage id in the order the source rail lists them. */
  passageIds?: string[];
  strategy?: string;
}) {
  if (!text) {
    return (
      <section aria-label="VIVA" className="surface-card p-5">
        <p className="eyebrow">VIVA</p>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-ash)" }}>
          Say what you think. VIVA answers from your source — or tells you when it can&apos;t find it there.
        </p>
      </section>
    );
  }

  const verdict = strategy ? VERDICT[strategy] : undefined;

  return (
    <section aria-label="What VIVA said" aria-live="polite" className="surface-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">VIVA</p>
        {verdict ? (
          <span className="chip" style={{ color: verdict.color, borderColor: verdict.color }}>
            {verdict.label}
          </span>
        ) : null}
      </div>

      <p className="prose-measure mt-2 leading-relaxed" style={{ color: "var(--color-paper)" }}>
        {text}
      </p>

      {evidenceIds.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
            From your source
          </span>
          {evidenceIds.map((id, i) => {
            const inRail = passageIds.indexOf(id);
            return (
              <a key={id} href={`#chunk-${id}`} className="chip chip-link min-h-11">
                Passage {inRail >= 0 ? inRail + 1 : i + 1}
              </a>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
