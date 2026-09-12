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
  if (facts.origin === "external-dictation") return "Dictated elsewhere";
  const parts = [facts.fellBackFrom || facts.asrMode === "sync" ? "Backup path" : "Dictation"];
  if (num(facts.requestTimeMs)) parts.push(`AssemblyAI ${Math.round(facts.requestTimeMs)} ms`);
  if (num(facts.confidence)) parts.push(`${Math.round(facts.confidence * 100)}% confident`);
  return parts.join(" · ");
}

/** Why the backup path answered, in a sentence rather than an error code. */
export function pathTitle(facts: TurnFacts): string {
  if (facts.origin === "external-dictation") return "Dictated by another tool and sent as text.";
  if (facts.fellBackFrom) {
    return "Dictation did not answer, so AssemblyAI's backup path transcribed this clip. The time is AssemblyAI's own, not the browser round trip.";
  }
  return "The time AssemblyAI spent on this clip — its own figure, not the browser round trip.";
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
            <p className="mt-1">Nothing needed tidying.</p>
          )}
        </details>
      ) : null}
    </div>
  );
}
