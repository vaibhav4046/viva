import type { ReactNode } from "react";

/*
 * These labels name a PART of the answer. None of them may be a band word.
 *
 * "MIXED UP" was, and a card can carry it at the same time as the verdict chip
 * says something else: the chip reads `verdict`, this block renders whenever
 * the marker returned a misconception, and the two are independent. Invented
 * technobabble came back as a blue "Partly there" chip 51 px above a red
 * "MIXED UP" — two verdicts on one card, the friendlier one on top, and a
 * student skimming on a phone reads the chip. Each label was defensible alone;
 * together they contradicted.
 *
 * The chip is the verdict, so it keeps the band word and this stops using one.
 * "CLEAR THIS FIRST" is the phrase the Daily Path already prints over the same
 * event (src/components/today/SegmentCard.tsx), so the two screens name it the
 * same way. Same fix as that one: when a label and a verdict collide, the
 * thing that is not the verdict gives up the word.
 */
const TONE: Record<string, { color: string; label: string }> = {
  // The band token, not the accent, though the two are the same hex today:
  // this is a statement about the answer, not a control. See globals.css.
  correct: { color: "var(--color-band-solid)", label: "CORRECT" },
  missing: { color: "var(--color-band-getting)", label: "MISSING" },
  misconception: { color: "var(--color-band-mixed)", label: "CLEAR THIS FIRST" },
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
