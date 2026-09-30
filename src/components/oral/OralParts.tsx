"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageMarkIcon, KeyboardIcon, MicrophoneIcon } from "@/components/ui/icons";
import { CorrectionMark, StatusChip } from "@/components/ui/exam";
import type { DiagSummary } from "./diag";
import { methodLabel, type FailureAction, type FailureView, type SourceCard } from "./model";
import type { OralTurn } from "./mic";

/* Small pieces of the /oral screen. Each one is presentational; the state lives in useOralSession. */

export function Clock({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [startedAt]);
  const total = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  return <span className="mono oral-clock" aria-label={`Elapsed ${text}`}>{text}</span>;
}

export function HeadphoneNote() {
  return (
    <section className="oral-prep" aria-labelledby="oral-prep-h">
      <h2 id="oral-prep-h" className="heading" style={{ fontSize: "var(--fs-h3)" }}>Before you start</h2>
      <ul className="grid gap-1" style={{ color: "var(--text-secondary)", fontSize: "var(--fs-body-sm)" }}>
        <li>Put headphones on. On speakers the microphone hears the examiner and it interrupts itself.</li>
        <li>Allow the microphone when the browser asks. If you would rather type, use Type instead.</li>
        <li>You can talk over the examiner to cut in. While it checks your pages, what you say is held until the check finishes.</li>
      </ul>
    </section>
  );
}

const ACTION_LABEL: Record<FailureAction, string> = {
  retry: "Start again",
  type: "Type instead",
  recorded: "Watch the recorded exam",
  reload: "Reload the page",
  end: "End the exam",
};

/** A blocking failure is a role=alert panel; a notice is a polite status. Both name the cause and the next action. */
export function FailurePanel({
  view,
  onAction,
  onDebrief,
}: {
  view: FailureView;
  onAction: (a: FailureAction) => void;
  onDebrief?: () => void;
}) {
  const blocking = view.blocking;
  return (
    <section
      className={blocking ? "oral-alert" : "oral-notice"}
      role={blocking ? "alert" : "status"}
      aria-labelledby={`fail-${view.id}`}
    >
      <p className="mono" style={{ color: blocking ? "var(--correction)" : "var(--warning)" }}>
        {blocking ? "Exam stopped" : "Notice"}
      </p>
      <h2 id={`fail-${view.id}`} className={blocking ? "oral-alert-title" : "oral-notice-title"}>{view.title}</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--fs-body-sm)" }}>
        <span className="mono" style={{ color: "var(--text-muted)" }}>What happened: </span>
        {view.cause}.
      </p>
      <p>{view.message}</p>
      {view.actions.length > 0 || onDebrief ? (
        <div className="oral-alert-actions">
          {view.actions.map((a, i) => {
            const cls = i === 0 ? "btn-primary" : "btn-ghost";
            if (a === "recorded") return <Link key={a} href="/recorded" className={cls}>{ACTION_LABEL[a]}</Link>;
            return (
              <button key={a} type="button" className={cls} onClick={() => onAction(a)}>
                {a === "type" ? <KeyboardIcon size={18} /> : a === "retry" ? <MicrophoneIcon size={18} /> : null}
                {ACTION_LABEL[a]}
              </button>
            );
          })}
          {onDebrief ? <button type="button" className="btn-ghost" onClick={onDebrief}>See the debrief so far</button> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The page the examiner read: page number in mono, the verbatim quote with each matched span marked, and how it was checked. */
export function SourcePassage({ source }: { source: SourceCard }) {
  const contradicted = source.verdict === "contradicted";
  return (
    <article className="passage-quoted rounded-md p-4" aria-label={`Page ${source.page ?? "unknown"}, ${source.verdict}`}>
      <p className="oral-source-claim">
        <span className="mono" style={{ color: "var(--text-muted)" }}>You said: </span>
        {contradicted ? <CorrectionMark>{source.claim}</CorrectionMark> : source.claim}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono inline-flex items-center gap-1.5" style={{ color: "var(--text-primary)" }}>
          <PageMarkIcon size={16} />
          {source.page != null ? `p. ${source.page}` : "page not recorded"}
        </span>
        {source.passageId ? <span className="mono" style={{ color: "var(--text-muted)" }}>{source.passageId}</span> : null}
        <StatusChip tone={contradicted ? "correction" : "success"}>{contradicted ? "Contradicted" : "Supported"}</StatusChip>
      </div>
      <blockquote className="mt-2" style={{ margin: "8px 0 0", fontSize: "var(--fs-body-sm)", lineHeight: 1.6, maxWidth: "var(--measure)" }}>
        {source.spans.map((span, i) => (
          <span key={i}>
            {i > 0 ? " ... " : null}
            <mark style={{ background: "var(--success-tint)", color: "var(--text-primary)", textDecorationLine: "underline", textDecorationColor: "var(--success)", textDecorationThickness: "2px", textUnderlineOffset: "3px" }}>{span}</mark>
          </span>
        ))}
      </blockquote>
      <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>{methodLabel(source.method, source.verdict)}</p>
    </article>
  );
}

/** Collapsible stack on a phone, a plain column on a desktop (CSS decides which). */
export function SourcesColumn({ sources, live }: { sources: SourceCard[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="oral-sources" data-open={open} aria-labelledby="oral-sources-h">
      <h2 id="oral-sources-h" className="oral-sources-h">Pages checked ({sources.length})</h2>
      {sources.length > 0 ? (
        <button type="button" className="oral-sources-toggle" aria-expanded={open} aria-controls="oral-sources-body" onClick={() => setOpen((v) => !v)}>
          <span>{open ? "Hide the pages" : "Show the pages"}</span>
          <span className="mono">{sources.length}</span>
        </button>
      ) : null}
      <div id="oral-sources-body" className="oral-sources-body">
        {sources.length === 0 ? (
          <p className="oral-empty">
            {live
              ? "Nothing checked yet. When you make a claim, the examiner reads your pages and the exact line appears here."
              : "The pages the examiner checks appear here, with the exact line it read and its page number."}
          </p>
        ) : (
          sources.map((s) => <SourcePassage key={s.id} source={s} />)
        )}
      </div>
    </section>
  );
}

export function Transcript({ lines }: { lines: OralTurn[] }) {
  return (
    <details className="oral-transcript">
      <summary>Transcript ({lines.length} {lines.length === 1 ? "line" : "lines"})</summary>
      {lines.length === 0 ? (
        <p className="oral-empty mt-2">Every line, yours and the examiner's, is written here as it is said.</p>
      ) : (
        <ol>
          {lines.map((t, i) => (
            <li key={i}>
              <p className="mono" style={{ color: "var(--text-secondary)" }}>{t.speaker === "user" ? "You" : "Examiner"}{t.interrupted ? ", cut off" : ""}</p>
              <p style={{ fontSize: "var(--fs-body-sm)" }}>{t.text}</p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

const ms = (v: number | null) => (v == null ? "not measured yet" : `${v} ms`);

/** ?diag=1 only. Every number is derived from events of this session; empty until there are events. */
export function DiagDrawer({ summary, discards = null }: { summary: DiagSummary; discards?: number | null }) {
  return (
    <aside className="oral-diag" aria-labelledby="oral-diag-h">
      <h2 id="oral-diag-h" className="heading" style={{ fontSize: "var(--fs-h3)" }}>Diagnostics, this session only</h2>
      {summary.events === 0 ? (
        <p className="oral-empty">No events yet. Start an exam and the measured numbers appear here.</p>
      ) : (
        <>
          <dl>
            <div><dt>Click to session.ready</dt><dd>{ms(summary.toSessionReadyMs)}</dd></div>
            <div><dt>Click to first examiner audio</dt><dd>{ms(summary.toFirstAudioMs)}</dd></div>
            <div><dt>Turns heard</dt><dd>{summary.turns}</dd></div>
            <div><dt>Trace events</dt><dd>{summary.events}</dd></div>
            <div><dt>Stale tool results dropped</dt><dd>{discards ?? "not counted"}</dd></div>
            <div>
              <dt>Barge-in: speech-started event to playback flushed</dt>
              <dd>{summary.bargeIns.length === 0 ? "none this session" : summary.bargeIns.map((b) => `${b.stopMs} ms`).join(", ")}</dd>
            </div>
            <div>
              <dt>Source check, request to result</dt>
              <dd>{summary.tools.length === 0 ? "none this session" : summary.tools.map((t) => `${t.name} ${t.ms} ms${t.ok ? "" : " (failed)"}`).join(", ")}</dd>
            </div>
          </dl>
          <div>
            <h3 className="mono">Partial transcript timeline</h3>
            {summary.partials.length === 0 ? <p className="oral-empty">No partial transcript yet.</p> : (
              <ol>{summary.partials.map((p, i) => <li key={i}>+{p.atMs} ms {p.text}</li>)}</ol>
            )}
          </div>
          <div>
            <h3 className="mono">Socket events</h3>
            {summary.socket.length === 0 ? <p className="oral-empty">No socket events yet.</p> : (
              <ol>{summary.socket.map((s, i) => <li key={i}>+{s.atMs} ms {s.label}</li>)}</ol>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
