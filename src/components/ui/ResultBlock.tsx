import type { ReactNode } from "react";

const TONE: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-cognition)", label: "CORRECT" },
  missing: { color: "var(--color-band-getting)", label: "MISSING" },
  misconception: { color: "var(--color-band-mixed)", label: "MIXED UP" },
  next: { color: "var(--color-paper)", label: "NEXT" },
};

/**
 * Assessment result block: label in token colour + hairline rule. The label
 * text always carries the state, so colour is never the only signal.
 */
export function ResultBlock({ tone, children }: { tone: keyof typeof TONE | string; children: ReactNode }) {
  const t = TONE[tone] ?? TONE.next;
  return (
    <div className="border-t pt-3 first:border-t-0 first:pt-0" style={{ borderColor: "var(--color-hairline)" }}>
      <p className="mono text-[11px] font-semibold tracking-widest" style={{ color: t.color }}>
        {t.label}
      </p>
      <div className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
        {children}
      </div>
    </div>
  );
}
