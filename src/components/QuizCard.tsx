"use client";
import type { ReactNode } from "react";
import { ResultBlock } from "@/components/ui/ResultBlock";

/**
 * The one quiz.
 *
 * There used to be two: /exam had a nudge, an "Answer this one again" control
 * and a map that moved, while /study's "quiz me" gave a single attempt, no
 * retry, and a card frozen on MISCONCEPTION forever. Learning the good one and
 * then meeting the worse one reads as a broken app, not as two screens. So the
 * question card and the verdict panel live here and both pages render them —
 * one state machine on the server, one set of words on the screen.
 *
 * The verdict says "Mixed up", not "MISCONCEPTION": a student is told which
 * band they landed in, never the internal accounting that put them there.
 */

export type QuizVerdict = "correct" | "partial" | "incorrect";

export type QuizAssessment = {
  verdict: QuizVerdict;
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
};

export const VERDICT_CHIP: Record<QuizVerdict, { color: string; label: string }> = {
  correct: { color: "var(--color-band-solid)", label: "Correct" },
  partial: { color: "var(--color-band-getting)", label: "Partly there" },
  incorrect: { color: "var(--color-band-mixed)", label: "Mixed up" },
};

/** The open question. `status` is the mic/marked chip the page supplies. */
export function QuizQuestion({
  eyebrow,
  question,
  status,
  large = false,
  children,
}: {
  eyebrow: string;
  question: string;
  status?: ReactNode;
  /** /exam gives the question the whole screen; /study keeps it in the stream. */
  large?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={large ? "surface-card p-6" : "surface-card p-5"} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">{eyebrow}</p>
        {status ?? null}
      </div>
      <p className={large ? "heading mt-2 text-[clamp(1.35rem,3.2vw,2rem)] leading-tight" : "heading mt-1 text-lg leading-snug"}>
        {question}
      </p>
      {children}
    </section>
  );
}

/**
 * The marked answer. `actions` is the row of buttons the page owns — the retry
 * is always one of them, because one attempt is not a quiz.
 */
export function QuizVerdictPanel({
  result,
  actions,
  label = "Marked answer",
}: {
  result: QuizAssessment;
  actions?: ReactNode;
  label?: string;
}) {
  const chip = VERDICT_CHIP[result.verdict] ?? VERDICT_CHIP.incorrect;
  const passages = result.evidenceIds.length;
  return (
    <section aria-label={label} aria-live="polite" className="surface-card space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="chip" style={{ color: chip.color, borderColor: chip.color }}>
          {chip.label}
        </span>
        {passages > 0 ? (
          <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
            Checked against {passages} passage{passages === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {/*
        * The band word is the only status word on this card. A partial answer
        * used to print the band chip "Partly there" and, directly under it, a
        * CORRECT block reading "You have part of it: order" — three labels, two
        * of them agreeing and the largest one disagreeing, for a one-word
        * answer. The block that carries CORRECT is also the block that echoes
        * the keyword the marker matched, so while the question is still open
        * for a retry it doubles as an answer key. Both go away by showing it
        * only once the answer actually is correct.
        */}
      {result.verdict === "correct" && result.correctPoints.length > 0 ? (
        <ResultBlock tone="correct">{result.correctPoints.join(" ")}</ResultBlock>
      ) : null}
      {result.missingPoints.length > 0 ? <ResultBlock tone="missing">{result.missingPoints.join(" ")}</ResultBlock> : null}
      {result.possibleMisconception ? <ResultBlock tone="misconception">{result.possibleMisconception}</ResultBlock> : null}
      <ResultBlock tone="next">
        {result.feedback}
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
      </ResultBlock>
    </section>
  );
}
