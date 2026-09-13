/**
 * What a turn cost, kept on the turn.
 *
 * The Clean/Verbatim toggle, the path chip and the real `request_time_ms` all
 * lived in the pre-send review panel, which auto-sends 1.5 s after the
 * transcript lands and took every one of them with it. After that the page
 * contained no ms figure, no path name and no verbatim text at all, so the two
 * things this integration is actually judged on — exactly what was said beside
 * the tidied version, and an honest upstream time — were unrecoverable one and
 * a half seconds later and gone entirely on reload.
 *
 * This is that same data rendered once more, in the conversation, where it
 * stays. Presentational and pure: no fetch, no state, no motion. The disclosure
 * is a native <details> so it works before hydration and with the keyboard.
 *
 * The number is AssemblyAI's OWN `request_time_ms`, not our round trip, and it
 * says so — the two differ by about 600 ms (median 1166 ms wall against 554 ms
 * upstream, measured on live), and quoting the round trip as the provider's
 * figure would be the kind of number this project does not print.
 */

import { CLEANUP_DROPPED } from "@/lib/audio/messages";
import { LIVE_ASR_MODE } from "@/lib/audio/stream";

/** Everything the footer needs. `VoiceTurn` satisfies this structurally. */
export type TurnFacts = {
  origin: "voice" | "typed" | "external-dictation";
  /** "dictation" | "sync" — which AssemblyAI path answered. */
  asrMode: string | null;
  /** AssemblyAI's own request_time_ms. NEVER the browser round trip. */
  requestTimeMs: number | null;
  /** 0..1 from the provider. */
  confidence: number | null;
  /** The Dictation error code that forced the fallback, when one did. */
  fellBackFrom?: string | null;
  /** Exactly what was said. */
  verbatim?: string | null;
  /** The tidied rewrite, when there was one. */
  clean?: string | null;
  /** Why there was no usable tidied rewrite, when there was not. */
  llmError?: string | null;
};

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The one-line summary, as text. Split out from the JSX because the render
 * cannot be unit-tested in this repo's node test environment and the label
 * decisions are exactly what must not drift.
 *
 * Returns null for typed text: the Note already carries a "Typed" chip, and a
 * footer saying nothing is worse than no footer.
 */
export function turnFactsLine(facts: TurnFacts): string | null {
  if (facts.origin === "typed") return null;
  // §4.5: a Wispr Flow / Windows dictation burst went through another tool's
  // recogniser, so claiming an AssemblyAI path or time for it would be a lie.
  //
  // "Pasted or dictated", not "Dictated elsewhere". src/lib/audio/burst.ts can
  // only tell that more than a line arrived inside 300 ms; a paste and a
  // dictation drop are identical at that layer, and its own comment says so.
  // Naming it dictation asserts the half we did not measure — which is exactly
  // the move this product refuses to make about a learner's claim, so it does
  // not get to make it about their input either.
  if (facts.origin === "external-dictation") return "Pasted or dictated";
  // The buffered clip failed and the learner sent the words the live socket
  // had painted instead. Different transcript, different path, no cleanup and
  // no upstream time — so it does not get to borrow the Dictation label, and
  // there is no ms figure to print because none was ever measured for it.
  if (facts.asrMode === LIVE_ASR_MODE) return "Live words · not the cleaned transcript";
  const parts = [facts.fellBackFrom || facts.asrMode === "sync" ? "Backup path" : "Dictation"];
  if (num(facts.requestTimeMs)) parts.push(`AssemblyAI ${Math.round(facts.requestTimeMs)} ms`);
  if (num(facts.confidence)) parts.push(`${Math.round(facts.confidence * 100)}% confident`);
  return parts.join(" · ");
}

/** Why the backup path answered, in a sentence rather than an error code. */
export function pathTitle(facts: TurnFacts): string {
  if (facts.origin === "external-dictation")
    return "This arrived as one block rather than keystrokes, so it was pasted or dictated by another tool. VIVA did not transcribe it and claims no time for it.";
  if (facts.asrMode === LIVE_ASR_MODE)
    return "The clip never came back, so these are the words the live stream had painted while you spoke. Nothing tidied them, and there is no AssemblyAI time or confidence for them.";
  if (facts.fellBackFrom) {
    return "Dictation did not answer, so AssemblyAI's backup path transcribed this clip. The time is AssemblyAI's own, not the browser round trip.";
  }
  return "The time AssemblyAI spent on this clip — its own figure, not the browser round trip.";
}

/**
 * What the disclosure says under the verbatim when there is no tidied version
 * beside it. "Nothing needed tidying" was the only answer, and it is only one
 * of three: the rewrite can also have been refused here for coming back
 * missing most of the clip, and live words were never offered one at all.
 */
export function tidyNote(facts: TurnFacts): string {
  if (facts.asrMode === LIVE_ASR_MODE) return "Nothing tidied these — the clip they belong to never came back.";
  if (facts.llmError === CLEANUP_DROPPED) return "The tidy-up came back missing most of these words, so it was not used.";
  return "Nothing needed tidying.";
}

export function TurnFooter({ facts }: { facts: TurnFacts | null | undefined }) {
  if (!facts) return null;
  const line = turnFactsLine(facts);
  if (!line) return null;
  const verbatim = facts.verbatim?.trim() ?? "";
  const clean = facts.clean?.trim() ?? "";
  const tidied = Boolean(verbatim) && Boolean(clean) && clean !== verbatim;

  return (
    <div className="mono pt-2 text-xs" style={{ color: "var(--color-ash)" }}>
      <span title={pathTitle(facts)}>{line}</span>
      {verbatim ? (
        <details className="mt-1">
          <summary className="cursor-pointer" style={{ minHeight: 24 }}>
            Exactly what you said
          </summary>
          <p className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            “{verbatim}”
          </p>
          {tidied ? (
            <>
              <p className="mt-2">Cleaned by AssemblyAI</p>
              <p className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
                “{clean}”
              </p>
            </>
          ) : (
            <p className="mt-1">{tidyNote(facts)}</p>
          )}
        </details>
      ) : null}
    </div>
  );
}
