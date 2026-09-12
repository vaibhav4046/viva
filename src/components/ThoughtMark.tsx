"use client";
import { motion } from "motion/react";
import type { LearningEvent } from "@/lib/types";

const INTENT_STYLE: Record<string, { icon: string; color: string; label: string }> = {
  confusion: { icon: "⚠", color: "var(--color-coral)", label: "CONFUSION" },
  remember: { icon: "▣", color: "var(--color-cognition)", label: "REMEMBER" },
  exam_marker: { icon: "◉", color: "var(--color-cognition)", label: "EXAM MARK" },
  claim: { icon: "◇", color: "var(--color-signal)", label: "YOUR CLAIM" },
  teachback: { icon: "▶", color: "var(--color-signal)", label: "TEACHBACK" },
  quiz_request: { icon: "?", color: "var(--color-signal)", label: "RECALL" },
  explain: { icon: "◈", color: "var(--color-paper)", label: "EXPLAIN" },
  question: { icon: "?", color: "var(--color-paper)", label: "QUESTION" },
  compare: { icon: "⇄", color: "var(--color-signal)", label: "COMPARE" },
  review_request: { icon: "↻", color: "var(--color-cognition)", label: "REVIEW" },
  connection: { icon: "⌁", color: "var(--color-signal)", label: "LINK" },
  correction: { icon: "✎", color: "var(--color-paper)", label: "FIX" },
  note: { icon: "·", color: "var(--color-ash)", label: "NOTE" },
};

export function ThoughtMark({ event, conceptName, delta }: { event: LearningEvent; conceptName?: string | null; delta?: number | null }) {
  const s = INTENT_STYLE[event.intent] ?? INTENT_STYLE.note;
  const voice = event.origin === "voice";
  const conf = event.transcriptionConfidence;
  return (
    <motion.article
      initial={{ scale: 0.92, opacity: 0, y: 8 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      aria-label={`Thought Mark: ${s.label} ${conceptName ?? ""}`}
      className="surface-card flex h-full w-full flex-col p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="tm-intent flex items-center gap-2 text-xs font-semibold tracking-widest" style={{ color: s.color }}>
          <span aria-hidden className="tm-dot" />
          <span aria-hidden>{s.icon}</span>
          <span>{s.label}</span>
        </div>
        <span
          className="chip"
          title={voice ? "Captured by voice dictation" : "Typed input — no transcription"}
        >
          <span aria-hidden>{voice ? "◉" : "⌨"}</span>
          {voice ? "voice" : "typed"}
          {voice && typeof conf === "number" ? <span>· {Math.round(conf * 100)}%</span> : null}
        </span>
      </div>
      <p className="heading mt-2 text-lg leading-snug">{conceptName ?? "New thought"}</p>
      <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>“{event.cleanedTranscript}”</p>
      <dl className="mono mt-auto space-y-1 pt-3 text-xs" style={{ color: "var(--color-ash)" }}>
        <div className="flex justify-between gap-3"><dt>source</dt><dd className="text-right">{event.sourceLocator ? `${event.sourceLocator.section ?? ""}${event.sourceLocator.page ? ` · p.${event.sourceLocator.page}` : ""}` : "—"}</dd></div>
        {typeof delta === "number" && (
          <div className="flex justify-between gap-3">
            <dt>mastery estimate</dt>
            <dd style={{ color: delta < 0 ? "var(--color-coral)" : "var(--color-cognition)" }}>
              {delta > 0 ? `+${Math.round(delta * 100)}` : Math.round(delta * 100)} pts
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-3"><dt>interpretation</dt><dd>{Math.round(event.interpretationConfidence * 100)}%</dd></div>
      </dl>
    </motion.article>
  );
}
