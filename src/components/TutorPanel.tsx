"use client";

const VERDICT: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-cognition)", label: "CORRECT" },
  partial: { color: "var(--color-signal)", label: "PARTIAL" },
  incorrect: { color: "var(--color-coral)", label: "MISCONCEPTION" },
};

export function TutorPanel({ text, evidenceIds, strategy }: { text: string | null; evidenceIds: string[]; strategy?: string }) {
  if (!text) {
    return (
      <section aria-label="Tutor" className="surface-card p-5">
        <p className="eyebrow">{"{ viva tutor }"}</p>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-ash)" }}>
          Speak or type above. VIVA answers from the source — or says when it cannot.
        </p>
      </section>
    );
  }
  const verdict = strategy ? VERDICT[strategy] : undefined;
  return (
    <section aria-label="Tutor response" aria-live="polite" className="surface-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">{"{ viva tutor }"}</p>
        {verdict ? (
          <span className="chip" style={{ color: verdict.color, borderColor: verdict.color }}>
            {verdict.label}
          </span>
        ) : null}
      </div>
      <p className="mt-2 leading-relaxed" style={{ color: "var(--color-paper)" }}>{text}</p>
      {evidenceIds.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
            EVIDENCE
          </span>
          {evidenceIds.map((id) => (
            <a key={id} href={`#chunk-${id}`} className="chip chip-link" style={{ color: "var(--color-signal)" }}>
              {id}
            </a>
          ))}
          {strategy && !verdict ? (
            <span className="mono text-[11px]" style={{ color: "var(--color-ash)" }}>· {strategy}</span>
          ) : null}
        </div>
      )}
    </section>
  );
}
