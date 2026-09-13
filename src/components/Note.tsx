"use client";
import { m, useReducedMotion } from "motion/react";
import { Keyboard, Mic } from "lucide-react";
import { SNAPPY, FADE_ONLY } from "@/lib/motion";
import { BAND_COLOR, BAND_LABEL, type BandKey } from "@/components/bands";
import { TurnFooter, type TurnFacts } from "@/components/voice/TurnFacts";
import type { LearningEvent } from "@/lib/types";

/**
 * A note: one thing the student said, and what it moved.
 *
 * This replaces the "Thought Mark" card. Same data, none of the internal
 * vocabulary — a student never has to learn our nouns to read their own
 * study history.
 */
/*
 * These labels used to carry a colour each, drawn from the mastery bands:
 * "You said" in periwinkle, "Confused" in coral, "For the exam" in lime. What
 * a student did is a different axis from how well they know it, so the card
 * was printing the band palette over a fact that has no band — and the same
 * screen shows the legend that teaches periwinkle as "Getting there".
 *
 * The word was always doing the work. Now it does it alone, in the ash every
 * other eyebrow in the product uses, which leaves exactly one colour on this
 * card: the band in the footer, which is the only thing here that is a verdict.
 */
const KIND_LABEL: Record<string, string> = {
  confusion: "Confused",
  remember: "Worth keeping",
  exam_marker: "For the exam",
  claim: "You said",
  teachback: "Taught it back",
  quiz_request: "Asked for a quiz",
  explain: "Asked for plain English",
  question: "Question",
  compare: "Compared",
  review_request: "Asked to review",
  connection: "Linked two ideas",
  correction: "Corrected yourself",
  // `hint` is a real intent (src/lib/types.ts) and had no entry here, so asking
  // for a nudge fell through to "Note" — the one label that says nothing about
  // what the student did.
  hint: "Asked for a hint",
  note: "Note",
};

export function Note({
  event,
  conceptName,
  band,
  facts,
}: {
  event: LearningEvent;
  conceptName?: string | null;
  /**
   * What the voice path cost on this turn, kept where it can be read again.
   * Absent on a typed turn and on a note restored from an older session, and
   * the footer renders nothing in both cases.
   */
  facts?: TurnFacts | null;
  /**
   * Where the concept sits now — never the signed move that got it there.
   *
   * A note used to print "Moved down -8" under an admission of confusion, so
   * saying "I don't get this" cost the student eight of something they were
   * never told the scale of. The rational move was to stop admitting it, which
   * is the one thing the product cannot survive. Confusion is a fact about the
   * concept; the concept's band is what says so.
   */
  band?: BandKey | null;
}) {
  const reduced = useReducedMotion();
  const kindLabel = KIND_LABEL[event.intent] ?? KIND_LABEL.note;
  const spoken = event.origin === "voice";
  /*
   * "Quiz me." and "Come back to this tomorrow." are instructions to the app,
   * not claims about a passage — filing them under a page number sends the
   * student back to a paragraph that has nothing to do with what they said. No
   * source line is the honest answer for those.
   *
   * Keyed on intent, not requestedAction: a claim the tutor answers with a
   * follow-up question comes back with requestedAction "quiz" too, and that
   * note does belong to a passage.
   */
  const process =
    event.intent === "quiz_request" || event.intent === "review_request" || event.intent === "hint";
  const where = event.sourceLocator && !process
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
        <span className="mono text-xs font-semibold tracking-widest uppercase" style={{ color: "var(--color-ash)" }}>
          {kindLabel}
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
        {band && conceptName ? (
          <div className="flex justify-between gap-3">
            <dt>Now</dt>
            <dd className="text-right" style={{ color: BAND_COLOR[band] }}>
              {BAND_LABEL[band]}
            </dd>
          </div>
        ) : null}
      </dl>
      <TurnFooter facts={facts} />
    </m.article>
  );
}
