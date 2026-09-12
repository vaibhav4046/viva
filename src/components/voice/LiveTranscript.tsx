"use client";

import { useEffect, useRef } from "react";
import type { LiveWord } from "@/lib/audio/stream";

/**
 * Words appearing as they are spoken.
 *
 * Purely presentational: it owns no socket, no microphone and no state. Give it
 * the `LiveState` fields from `@/lib/audio/stream` and it renders them.
 *
 * The whole point of the component is the difference between a word the model
 * is still willing to change and one it has committed to, so that difference is
 * the only thing the styling says. A provisional word is dimmed and sitting
 * fractionally low; when `word_is_final` flips it rises and comes up to full
 * weight. That is a transition on `opacity` and `transform` and nothing else —
 * both run on the compositor, so a sentence's worth of words settling at once
 * costs no layout.
 *
 * Why CSS transitions rather than the motion library used elsewhere: a long
 * utterance is 40+ simultaneously animating spans, and each one only ever moves
 * between two states. A declarative transition on a class is the cheapest
 * correct thing, and it keeps this component free of any animation runtime.
 *
 * Accessibility. The visual stream is `aria-hidden`: a screen reader announcing
 * every revision of every partial word is unusable noise. Finalised text goes
 * to a polite live region instead, so assistive tech hears the sentence settle
 * once rather than a dozen times. Under `prefers-reduced-motion` the transform
 * is dropped and only the opacity step remains — the state is still legible,
 * nothing travels.
 */

export function LiveTranscript({
  committed,
  words,
  listening,
  placeholder = "Start talking — your words appear here.",
  className,
}: {
  /** Turns the model has closed. Never revised again. */
  committed: string;
  /** The turn in flight, partial words included. */
  words: LiveWord[];
  /** Drives the caret. False once the mic is released. */
  listening?: boolean;
  /** Shown before the first word arrives. */
  placeholder?: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the newest word. `scrollTop` is not an animated property and this
  // runs on a container whose height is fixed, so it cannot shift the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [committed, words.length]);

  const empty = !committed && words.length === 0;

  return (
    <div className={className}>
      <style>{STYLES}</style>

      <div ref={scrollRef} className="viva-live" data-empty={empty || undefined} aria-hidden>
        {empty ? (
          <span className="viva-live__placeholder">{placeholder}</span>
        ) : (
          <>
            {committed && <span className="viva-live__word" data-final="true">{committed}</span>}
            {words.map((word, i) => (
              // Keyed by position, not by text: a partial word is revised in
              // place ("match" becoming "matter"), and keying by text would
              // unmount the old span and replay the entrance on every
              // correction — the settle would stutter instead of settling.
              <span key={i} className="viva-live__word" data-final={word.final || undefined}>
                {word.text}
              </span>
            ))}
            {listening && <span className="viva-live__caret" />}
          </>
        )}
      </div>

      {/* What assistive tech actually reads: settled text only, announced once. */}
      <p className="sr-only" aria-live="polite" aria-atomic="false">
        {committed}
      </p>
    </div>
  );
}

/**
 * Scoped by the `viva-live` prefix rather than a CSS module so the component
 * stays one file, which is what "self-contained" has to mean for something
 * another agent is about to drop into a page.
 *
 * The inline <style> is allowed by the app's CSP: `style-src` carries
 * 'unsafe-inline' for React's own style prop (see src/proxy.ts).
 */
const STYLES = `
.viva-live {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.3em;
  max-height: 9.5rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 1.125rem;
  line-height: 1.55;
  color: var(--color-paper);
  /* Tabular figures so a number does not reflow the line as it is revised. */
  font-variant-numeric: tabular-nums;
}
.viva-live[data-empty] { color: var(--color-ash); }
.viva-live__placeholder { font-size: 1rem; }

.viva-live__word {
  /* Provisional: dimmed, and sitting fractionally low so the settle has
     somewhere to travel from. Both properties are compositor-only. */
  opacity: 0.42;
  transform: translateY(0.09em);
  transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1),
              transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
  will-change: opacity, transform;
}
.viva-live__word[data-final] {
  opacity: 1;
  transform: none;
  /* The animation is over for this word; stop paying for a compositor layer. */
  will-change: auto;
}

.viva-live__caret {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  align-self: center;
  background: var(--color-cognition);
  animation: viva-live-blink 1.05s steps(2, start) infinite;
}
@keyframes viva-live-blink { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }

@media (prefers-reduced-motion: reduce) {
  /* Nothing travels. The opacity step still separates provisional from
     settled, so the one thing this component exists to show survives. */
  .viva-live__word { transform: none; transition: opacity 120ms linear; }
  .viva-live__caret { animation: none; }
}
`;
