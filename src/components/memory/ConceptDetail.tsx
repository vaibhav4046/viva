"use client";
import { useId, useState } from "react";
import { shortDate } from "@/components/today/types";
import { conceptEvents, intentLabel, isMisconceptionEvent, type EventWithAssessment } from "./signals";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

type QueueItem = { dueAt: string; priority: number; reason: string };

const OUTCOME_CHIP: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-cognition)", label: "CORRECT" },
  partial: { color: "var(--color-signal)", label: "PARTIAL" },
  incorrect: { color: "var(--color-coral)", label: "INCORRECT" },
};

function locatorText(e: LearningEvent): string | null {
  if (!e.sourceLocator) return null;
  const { section, page } = e.sourceLocator;
  const parts = [section, page ? `p.${page}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function OutcomeMeta({ e }: { e: EventWithAssessment }) {
  const chip = e.assessment ? OUTCOME_CHIP[e.assessment] : null;
  const deltaText =
    typeof e.delta === "number" ? `${e.delta > 0 ? "+" : ""}${Math.round(e.delta * 100)} pts` : null;
  if (!chip && !deltaText && !e.reason) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      {chip ? (
        <span className="chip" style={{ color: chip.color, borderColor: chip.color }}>
          {chip.label}
        </span>
      ) : null}
      {deltaText ? (
        <span className="mono text-[11px]" style={{ color: "var(--color-paper)" }}>
          Δ {deltaText}
        </span>
      ) : null}
      {e.reason ? (
        <span className="text-xs" style={{ color: "var(--color-mist)" }}>
          {e.reason}
        </span>
      ) : null}
    </span>
  );
}

function Quote({ e }: { e: EventWithAssessment }) {
  return (
    <span className="inline">
      “{e.cleanedTranscript}”
      <span className="mono ml-2 text-[11px]" style={{ color: "var(--color-ash)" }}>
        {intentLabel(e.intent)} · {shortDate(e.createdAt)}
      </span>
      <OutcomeMeta e={e} />
    </span>
  );
}

/**
 * §20 concept story + §23 Misconception Replay. Everything below is derived
 * from the event list (intents, transcripts, timestamps, evidenceIds) and the
 * mastery record; anything not derivable is labelled "not recorded".
 */
export function ConceptDetail({
  concept,
  mastery,
  prior,
  queueItem,
  events,
}: {
  concept: { id: string; name: string; description: string };
  mastery: ConceptMastery;
  prior?: number;
  queueItem?: QueueItem | null;
  events: LearningEvent[];
}) {
  const [replay, setReplay] = useState(false);
  const replayId = useId();

  const evs = conceptEvents(events, concept.id);
  const firstConfusion = evs.find((e) => e.intent === "confusion") ?? null;
  const misconceptionEvent = evs.find(isMisconceptionEvent) ?? null;
  const miscIdx = misconceptionEvent ? evs.indexOf(misconceptionEvent) : -1;
  const afterMisc = miscIdx >= 0 ? evs.slice(miscIdx + 1) : evs;
  const correctionEvent =
    afterMisc.find((e) => e.intent === "correction") ??
    afterMisc.find((e) => e.assessment === "correct" || e.assessment === "partial") ??
    null;
  const evidenceIds = [...new Set(evs.flatMap((e) => e.evidenceIds))].slice(0, 8);

  return (
    <section aria-label={`Concept detail — ${concept.name}`} className="surface-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="heading text-lg">{concept.name}</h3>
        <span className="chip" title="Deterministic VIVA estimate from your events">
          VIVA estimate {Math.round(mastery.mastery * 100)}%
        </span>
      </div>
      {prior !== undefined ? (
        <p className="mt-2">
          <span className="chip" title="Labeled start value for the seeded track — not a measured result.">
            demo prior {Math.round(prior * 100)}%
          </span>
        </p>
      ) : null}
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
        {concept.description}
      </p>

      <dl className="mt-5 space-y-4 text-sm">
        <div>
          <dt className="eyebrow">First confusion</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {firstConfusion ? <Quote e={firstConfusion} /> : "not recorded"}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Initial estimate</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {prior !== undefined
              ? `demo prior ${Math.round(prior * 100)}% — a labeled start value, not a measured result`
              : "not recorded"}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Misconception detected</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {misconceptionEvent ? (
              <Quote e={misconceptionEvent} />
            ) : mastery.misconceptionCount > 0 ? (
              `${mastery.misconceptionCount} incorrect answer${mastery.misconceptionCount === 1 ? "" : "s"} on record, but the specific event is not in your last 50 — not recorded`
            ) : (
              "none recorded"
            )}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Evidence</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {evidenceIds.length > 0 ? (
              <span className="flex flex-wrap gap-2">
                {evidenceIds.map((id) => (
                  <a key={id} href={`/demo#chunk-${id}`} className="chip chip-link" style={{ color: "var(--color-signal)" }}>
                    {id}
                  </a>
                ))}
              </span>
            ) : (
              "not recorded"
            )}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Corrected</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {mastery.lastSuccessfulRecallAt ? (
              correctionEvent ? (
                <Quote e={correctionEvent} />
              ) : (
                `${shortDate(mastery.lastSuccessfulRecallAt)} — a successful recall is recorded in your mastery; the individual event is not in your last 50`
              )
            ) : (
              "not recorded"
            )}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Successful recalls</dt>
          <dd className="mono mt-1" style={{ color: "var(--color-paper)" }}>
            {mastery.successfulRecallCount}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Next review</dt>
          <dd className="mt-1 leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {queueItem ? `due ${shortDate(queueItem.dueAt)} · ${queueItem.reason}` : "not scheduled — review priority below threshold"}
          </dd>
        </div>
      </dl>

      <section aria-label="Why the estimate changed" className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-hairline)" }}>
        <h4 className="eyebrow">Why the estimate changed</h4>
        <ul className="mt-2 space-y-1.5 text-sm" style={{ color: "var(--color-mist)" }}>
          <li className="flex flex-wrap justify-between gap-x-3">
            <span>confusion recorded → −8 pts each</span>
            <span className="mono text-xs">applied ×{mastery.confusionCount}</span>
          </li>
          <li className="flex flex-wrap justify-between gap-x-3">
            <span>incorrect claim / teachback → −12 pts each</span>
            <span className="mono text-xs">applied ×{mastery.misconceptionCount}</span>
          </li>
          <li className="flex flex-wrap justify-between gap-x-3">
            <span>correct recall → +6 pts (claim) or +12 pts (teachback)</span>
            <span className="mono text-xs">{mastery.successfulRecallCount} successful</span>
          </li>
          <li className="flex flex-wrap justify-between gap-x-3">
            <span>exposure and request markers → +1 or +2 pts each</span>
            <span className="mono text-xs">not attributable from stored aggregates</span>
          </li>
        </ul>
        <p className="mono mt-2 text-[11px]" style={{ color: "var(--color-ash)" }}>
          VIVA estimate — deterministic rules over your own events, not a claim about your brain.
        </p>
      </section>

      <div className="mt-5">
        <button
          type="button"
          className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm"
          aria-expanded={replay}
          aria-controls={replay ? replayId : undefined}
          onClick={() => setReplay((v) => !v)}
        >
          {replay ? "Hide the replay" : "Show me where I went wrong"}
        </button>
      </div>

      {replay ? (
        <div id={replayId} className="mt-3">
          <MisconceptionReplay evs={evs} mastery={mastery} correctionEvent={correctionEvent} />
        </div>
      ) : null}
    </section>
  );
}

function MisconceptionReplay({
  evs,
  mastery,
  correctionEvent,
}: {
  evs: EventWithAssessment[];
  mastery: ConceptMastery;
  correctionEvent: EventWithAssessment | null;
}) {
  const first = evs[0] ?? null;
  const firstIdx = first ? 0 : -1;
  const evidenceEvent =
    firstIdx >= 0 ? evs.slice(firstIdx).find((e) => e.evidenceIds.length > 0 || e.sourceLocator) ?? null : null;
  const hintEvent =
    (firstIdx >= 0 ? evs.slice(firstIdx + 1).find((e) => e.hint) : null) ??
    (firstIdx >= 0
      ? evs.slice(firstIdx + 1).find((e) => e.intent === "quiz_request" || e.requestedAction === "quiz") ?? null
      : null);
  const last = evs[evs.length - 1] ?? null;

  const dot = "absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border";
  const dotStyle = { borderColor: "var(--color-hairline)", background: "var(--color-graphite)" };

  return (
    <section aria-label="Misconception replay">
      <p className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
        REPLAY · BUILT ONLY FROM RECORDED EVENTS
      </p>
      <ol className="relative mt-3 space-y-5 border-l pl-5" style={{ borderColor: "var(--color-hairline)" }}>
        <li className="relative">
          <span aria-hidden className={dot} style={dotStyle} />
          <p className="eyebrow">1 · Original statement</p>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {first ? <Quote e={first} /> : "not recorded"}
          </p>
        </li>

        <li className="relative">
          <span aria-hidden className={dot} style={dotStyle} />
          <p className="eyebrow">2 · Evidence conflict</p>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {evidenceEvent ? (
              <span className="flex flex-wrap items-center gap-2">
                {locatorText(evidenceEvent) ? <span className="mono text-[11px]">{locatorText(evidenceEvent)}</span> : null}
                {evidenceEvent.evidenceIds.map((id) => (
                  <a key={id} href={`/demo#chunk-${id}`} className="chip chip-link" style={{ color: "var(--color-signal)" }}>
                    {id}
                  </a>
                ))}
              </span>
            ) : (
              "not recorded — no retrieved passage is attached to these events"
            )}
          </p>
        </li>

        <li className="relative">
          <span aria-hidden className={dot} style={dotStyle} />
          <p className="eyebrow">3 · Hint</p>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {hintEvent ? (
              hintEvent.hint ? (
                <>
                  “{hintEvent.hint}”
                  <span className="mono ml-2 text-[11px]" style={{ color: "var(--color-ash)" }}>
                    the hint you were given · {intentLabel(hintEvent.intent)} · {shortDate(hintEvent.createdAt)}
                  </span>
                  <OutcomeMeta e={hintEvent} />
                </>
              ) : (
                <>
                  <Quote e={hintEvent} />
                  <span className="mono ml-2 text-[11px]" style={{ color: "var(--color-ash)" }}>
                    the hint text is not recorded on this event
                  </span>
                </>
              )
            ) : (
              "not recorded — no recall request followed this statement"
            )}
          </p>
        </li>

        <li className="relative">
          <span aria-hidden className={dot} style={dotStyle} />
          <p className="eyebrow">4 · Your correction</p>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {correctionEvent ? (
              <Quote e={correctionEvent} />
            ) : mastery.lastSuccessfulRecallAt ? (
              `a successful recall is recorded (${shortDate(mastery.lastSuccessfulRecallAt)}), but the individual event is not in your last 50`
            ) : (
              "not recorded"
            )}
          </p>
        </li>

        <li className="relative">
          <span aria-hidden className={dot} style={dotStyle} />
          <p className="eyebrow">5 · Current understanding</p>
          <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            VIVA estimate {Math.round(mastery.mastery * 100)}% · {mastery.successfulRecallCount} successful recall
            {mastery.successfulRecallCount === 1 ? "" : "s"} · {mastery.confusionCount} confusion
            {mastery.confusionCount === 1 ? "" : "s"} · {mastery.misconceptionCount} misconception
            {mastery.misconceptionCount === 1 ? "" : "s"} on record.
            {last ? (
              <span className="mono ml-2 text-[11px]" style={{ color: "var(--color-ash)" }}>
                latest signal: {intentLabel(last.intent)} · {shortDate(last.createdAt)}
              </span>
            ) : null}
          </p>
        </li>
      </ol>
    </section>
  );
}
