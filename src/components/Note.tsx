"use client";
import { m, useReducedMotion } from "motion/react";
import { Keyboard, Mic } from "lucide-react";
import { SNAPPY, FADE_ONLY } from "@/lib/motion";
import type { LearningEvent } from "@/lib/types";

/**
 * A note: one thing the student said, and what it moved.
 *
 * This replaces the "Thought Mark" card. Same data, none of the internal
 * vocabulary — a student never has to learn our nouns to read their own
 * study history.
 */
const KIND: Record<string, { color: string; label: string }> = {
  confusion: { color: "var(--color-band-mixed)", label: "Confused" },
  remember: { color: "var(--color-band-solid)", label: "Worth keeping" },
  exam_marker: { color: "var(--color-band-solid)", label: "For the exam" },
  claim: { color: "var(--color-band-getting)", label: "You said" },
  teachback: { color: "var(--color-band-getting)", label: "Taught it back" },
  quiz_request: { color: "var(--color-band-getting)", label: "Asked for a quiz" },
  explain: { color: "var(--color-paper)", label: "Asked for plain English" },
  question: { color: "var(--color-paper)", label: "Question" },
  compare: { color: "var(--color-band-getting)", label: "Compared" },
  review_request: { color: "var(--color-band-solid)", label: "Asked to review" },
  connection: { color: "var(--color-band-getting)", label: "Linked two ideas" },
  correction: { color: "var(--color-paper)", label: "Corrected yourself" },
  note: { color: "var(--color-ash)", label: "Note" },
};

export function Note({
  event,
  conceptName,
  delta,
}: {
  event: LearningEvent;
  conceptName?: string | null;
  delta?: number | null;
}) {
  const reduced = useReducedMotion();
  const kind = KIND[event.intent] ?? KIND.note;
  const spoken = event.origin === "voice";
  const where = event.sourceLocator
    ? `${event.sourceLocator.section ?? ""}${event.sourceLocator.page ? ` · p.${event.sourceLocator.page}` : ""}`.trim()
    : "";

  return (
    <m.article
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={reduced ? FADE_ONLY : SNAPPY}
      aria-label={`Note${conceptName ? ` about ${conceptName}` : ""}`}
      className="surface-card flex h-full w-full flex-col p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-xs font-semibold tracking-widest uppercase" style={{ color: kind.color }}>
          {kind.label}
        </span>
        <span className="chip" title={spoken ? "Captured by voice" : "Typed"}>
          {spoken ? <Mic size={12} aria-hidden /> : <Keyboard size={12} aria-hidden />}
          {spoken ? "Spoken" : "Typed"}
        </span>
      </div>

      {conceptName ? <p className="heading mt-2 text-lg leading-snug">{conceptName}</p> : null}
      <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
        “{event.cleanedTranscript}”
      </p>

      <dl className="mono mt-auto space-y-1 pt-3 text-xs" style={{ color: "var(--color-ash)" }}>
        {where ? (
          <div className="flex justify-between gap-3">
            <dt>Source</dt>
            <dd className="text-right">{where}</dd>
          </div>
        ) : null}
        {typeof delta === "number" && delta !== 0 ? (
          <div className="flex justify-between gap-3">
            <dt>{delta < 0 ? "Moved down" : "Moved up"}</dt>
            <dd className="tnum" style={{ color: delta < 0 ? "var(--color-band-mixed)" : "var(--color-band-solid)" }}>
              {delta > 0 ? "+" : ""}
              {Math.round(delta * 100)}
            </dd>
          </div>
        ) : null}
      </dl>
    </m.article>
  );
}
