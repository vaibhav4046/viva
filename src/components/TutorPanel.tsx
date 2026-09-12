"use client";

const VERDICT: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-band-solid)", label: "Correct" },
  partial: { color: "var(--color-band-getting)", label: "Partly there" },
  incorrect: { color: "var(--color-band-mixed)", label: "Mixed up" },
};

/**
 * What VIVA said back.
 *
 * Citations link to the passage they came from. They are numbered rather than
 * shown as stored ids: "ch_pos_1" tells a student nothing, and the number is
 * the only part they need to find the passage on the left.
 */
export function TutorPanel({
  text,
  evidenceIds,
  strategy,
}: {
  text: string | null;
  evidenceIds: string[];
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
          {evidenceIds.map((id, i) => (
            <a key={id} href={`#chunk-${id}`} className="chip chip-link min-h-11">
              Passage {i + 1}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}
