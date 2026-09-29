"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { createController, type Controller, type ControllerState, type SessionView, type VoiceConfig } from "@/lib/redteam/controller";
import type { Claim, ClaimStatus, Passage } from "@/lib/redteam/types";
import { httpApi } from "./api";
import { openAudio, type AudioHandle } from "./audio";
import { KIND_LABEL, STATUS_META, STATUS_ORDER, stateLine } from "./status";
import { ReportView } from "./ReportView";

type Tab = "source" | "review" | "map";

/* ------------------------------------------------------------- helpers */

function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(q.matches);
    const on = () => setR(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return r;
}

const cite = (p: Passage | undefined) => (p ? `${p.section.replace(/^\d+\.\s*/, "")} · ${p.ordinal + 1}` : "");

/* --------------------------------------------------------------- source */

type Mark = "supported" | "contradicted" | "partial" | "asked";

function SourcePane({ view, selected, markNumbers, askedIds, reduced }: { view: SessionView; selected: Claim | null; markNumbers: Map<string, number[]>; askedIds: string[]; reduced: boolean }) {
  const marks = useMemo(() => {
    const m = new Map<string, Mark>();
    for (const id of askedIds) m.set(id, "asked");
    if (selected) {
      const soft: Mark = selected.status === "PARTIAL" ? "partial" : "supported";
      for (const id of selected.evidencePassageIds) m.set(id, soft);
      for (const id of selected.contradictionPassageIds) m.set(id, "contradicted");
    }
    return m;
  }, [selected, askedIds]);

  // A mark is "drawn" the moment it first appears, not on every render.
  const seen = useRef(new Map<string, Mark>());
  const drawing = useRef(new Set<string>());
  drawing.current = new Set();
  for (const [id, m] of marks) if (seen.current.get(id) !== m) drawing.current.add(id);
  useEffect(() => {
    seen.current = new Map(marks);
  }, [marks]);

  const target = selected?.contradictionPassageIds[0] ?? selected?.evidencePassageIds[0] ?? askedIds[0];
  useEffect(() => {
    if (!target) return;
    document.getElementById(`p-${target}`)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [target, selected?.updatedAt, reduced]);

  const byId = useMemo(() => new Map(view.document.passages.map((p) => [p.id, p])), [view.document.passages]);
  return (
    <section className="rt-pane rt-source" aria-label="Source document" tabIndex={0}>
      <div className="rt-pane__head">
        <h2>Source</h2>
        {view.document.sample ? <span className="rt-tag rt-tag--sample">Sample material</span> : <span className="rt-tag">Your document</span>}
      </div>
      <div className="rt-doc-body" data-testid="source-body">
        {view.document.sections.map((s) => (
          <div className="rt-section" key={s.id}>
            <h3>{s.heading}</h3>
            <p>
              {s.passageIds.map((id) => {
                const p = byId.get(id);
                if (!p) return null;
                const nums = markNumbers.get(id);
                return (
                  <span key={id} id={`p-${id}`} className="rt-passage" data-mark={marks.get(id)} data-draw={drawing.current.has(id) ? "true" : undefined}>
                    {p.text}
                    {nums?.length ? <sup title={`Referenced by claim ${nums.join(", ")}`}>{nums.join(",")}</sup> : null}
                  </span>
                );
              })}
            </p>
          </div>
        ))}
      </div>
      <div className="rt-legend" aria-label="How the source is marked">
        <span>
          <i style={{ background: "var(--rt-mark-supported)" }} />
          backs the selected claim
        </span>
        <span>
          <i style={{ background: "var(--rt-mark-contradicted)" }} />
          contradicts it
        </span>
        <span>
          <i style={{ background: "var(--rt-mark-asked)" }} />
          the current question
        </span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- waveform */

function Wave({ audio, speaking, live }: { audio: AudioHandle | null; speaking: boolean; live: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    const style = getComputedStyle(canvas);
    const ink = speaking ? style.getPropertyValue("--rt-text").trim() || "#ece8de" : "#86c596";
    const samples = new Uint8Array(1024);
    let raf = 0;
    const draw = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.5);
      ctx.strokeStyle = ink;
      ctx.beginPath();
      if (audio && live) {
        // The real signal: the microphone while you speak, VIVA's own output while it does.
        (speaking ? audio.readAgent : audio.readMic)(samples);
        for (let i = 0; i < samples.length; i++) {
          const x = (i / (samples.length - 1)) * w;
          const y = (samples[i] / 255) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
      }
      ctx.stroke();
    };
    draw();
    // Only loop while there is a signal to read. With no audio open there is
    // nothing to animate, so nothing does.
    if (audio && live) {
      const tick = () => {
        draw();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [audio, speaking, live]);
  return (
    <div className="rt-wave">
      <span className="rt-label rt-wave__cap">{!audio || !live ? "No microphone open" : speaking ? "VIVA's voice" : "Your microphone"}</span>
      <canvas ref={ref} aria-hidden />
    </div>
  );
}

/* ---------------------------------------------------------------- voice */

function Timeline({ view }: { view: SessionView }) {
  const kindLabel: Record<string, string> = { challenge: "Question", claim: "You said", verdict: "Verdict", interruption: "Interrupted", correction: "Correction", finish: "Ended" };
  const byId = new Map(view.document.passages.map((p) => [p.id, p]));
  return (
    <details className="rt-timeline" data-testid="timeline">
      <summary>
        <span className="rt-label">Session timeline · {view.timeline.length}</span>
      </summary>
      <ol>
        {view.timeline.map((e) => (
          <li key={e.id} className="rt-ev" data-kind={e.kind}>
            <span className="rt-ev__kind">{kindLabel[e.kind] ?? e.kind}</span>
            <span>
              {e.text}
              {e.from || e.to ? (
                <span className="rt-ev__shift">
                  {e.from ? STATUS_META[e.from].label : null}
                  {e.from && e.to ? " → " : null}
                  {e.to ? STATUS_META[e.to].label : null}
                </span>
              ) : null}
              {e.passageIds.length ? <span className="rt-ev__shift">{e.passageIds.slice(0, 3).map((id) => cite(byId.get(id))).filter(Boolean).join(" · ")}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function VoicePane({
  st,
  ctrl,
  audio,
  voiceLive,
  onStartVoice,
  onStopVoice,
  localError,
  onFinish,
  finishing,
  onShowMap,
}: {
  st: ControllerState;
  ctrl: Controller;
  audio: AudioHandle | null;
  voiceLive: boolean;
  onStartVoice: () => void;
  onStopVoice: () => void;
  localError: string | null;
  onFinish: () => void;
  finishing: boolean;
  onShowMap: () => void;
}) {
  const [text, setText] = useState("");
  const [typedOpen, setTypedOpen] = useState(false);
  const challenge = st.session.challenges.at(-1);
  const latest = st.session.claims.find((c) => c.id === st.session.activeClaimId) ?? st.session.claims.at(-1) ?? null;
  const awaiting = st.session.claims.some((c) => c.awaitingCorrection);
  const machineState = st.machine?.state ?? "IDLE";
  const typedOnly = st.mode === "typed" && !voiceLive;
  const line = stateLine(typedOnly ? "TYPED" : machineState, { awaitingCorrection: awaiting });
  const detail = machineState === "ERROR" && st.error ? st.error : line.detail;
  const showTyped = typedOpen || typedOnly || machineState === "ERROR" || Boolean(localError);
  const canStart = !voiceLive && machineState !== "CONNECTING";

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setText("");
    await ctrl.typed(v);
  };

  return (
    <section className="rt-pane rt-voice" aria-label="Voice review">
      <div className="rt-pane__head">
        <h2>Voice review</h2>
        <span className="rt-tag">{st.session.mode.toLowerCase()}</span>
      </div>

      <div className="rt-challenge" data-testid="challenge">
        <div className="rt-challenge__meta">
          <span className="rt-tag">{challenge ? KIND_LABEL[challenge.kind] : "Waiting"}</span>
        </div>
        <p className="rt-challenge__q">{challenge?.question ?? "No question yet."}</p>
      </div>

      <div className="rt-state" data-state={typedOnly ? "TYPED" : machineState} data-testid="state" role="status">
        <span className="rt-state__dot" aria-hidden />
        <span className="rt-state__label" data-testid="state-label">
          {line.label}
        </span>
        <span className="rt-state__detail">{detail}</span>
      </div>

      <Wave audio={audio} speaking={machineState === "SPEAKING"} live={voiceLive} />

      {latest ? (
        <div className="rt-latest" data-testid="latest-verdict" data-status={latest.status} aria-live="polite">
          <span className="rt-shape" data-shape={STATUS_META[latest.status].shape} aria-hidden />
          <span>
            <b>{STATUS_META[latest.status].label}</b>
            {st.lastChange?.claimId === latest.id ? (
              <span className="rt-card__shift" style={{ marginLeft: 8 }}>
                {STATUS_META[st.lastChange.from].label} → {STATUS_META[st.lastChange.to].label}
              </span>
            ) : null}
            <br />
            <span className="rt-latest__claim">{latest.normalizedClaim}</span>
          </span>
          <button className="rt-chip" onClick={onShowMap}>
            Open map
          </button>
        </div>
      ) : null}

      {localError || (st.error && machineState !== "ERROR") ? (
        <div className="rt-error" role="alert" style={{ margin: "12px 22px 0" }}>
          {localError ?? st.error}
        </div>
      ) : null}
      {st.degraded ? (
        <p className="rt-note" style={{ margin: "10px 22px 0", color: "var(--rt-text-2)" }} data-testid="degraded">
          Some voice settings were refused, so the session runs on defaults ({st.degraded}).
        </p>
      ) : null}

      <div className="rt-controls">
        {voiceLive ? (
          <button className="rt-btn" onClick={onStopVoice}>
            Stop voice
          </button>
        ) : (
          <button className="rt-btn rt-btn--primary" onClick={onStartVoice} disabled={!canStart || st.report !== null} data-testid="start-voice">
            {machineState === "CONNECTING" ? "Connecting…" : "Start voice review"}
          </button>
        )}
        <button className="rt-btn" onClick={() => setTypedOpen((v) => !v)} aria-expanded={showTyped} aria-controls="rt-typed">
          Type instead
        </button>
        <button className="rt-btn" onClick={() => void ctrl.typedNext()} data-testid="next-question">
          Next question
        </button>
        <button className="rt-btn rt-btn--danger" onClick={onFinish} disabled={finishing} data-testid="finish">
          Finish and build report
        </button>
      </div>

      {showTyped ? (
        <form id="rt-typed" className="rt-type" onSubmit={send}>
          <label className="rt-sr" htmlFor="rt-typed-input" style={{ position: "absolute", left: -9999 }}>
            Type your answer
          </label>
          <input id="rt-typed-input" data-testid="typed-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type what you would say" maxLength={1000} autoComplete="off" />
          <button className="rt-btn rt-btn--primary" type="submit" disabled={!text.trim()}>
            Send
          </button>
          <div className="rt-type__row">
            <button type="button" className="rt-btn" data-testid="typed-interrupt" onClick={() => void ctrl.typedInterrupt()}>
              Cut VIVA off
            </button>
            <span className="rt-note" style={{ color: "var(--rt-text-2)", alignSelf: "center" }}>
              Typed answers use the same checks. This is not the Voice Agent.
            </span>
          </div>
        </form>
      ) : null}

      <div className="rt-transcript" role="log" aria-live="polite" aria-label="Transcript" data-testid="transcript">
        {st.transcript.length === 0 && !st.partial ? <p className="rt-empty">Nothing has been said yet.</p> : null}
        {st.transcript.map((l) => (
          <div key={l.id} className="rt-line" data-who={l.speaker} data-cut={l.interrupted ? "true" : undefined}>
            <span className="rt-line__who">{l.speaker === "user" ? "You" : "VIVA"}</span>
            <span className="rt-line__text">{l.text}</span>
          </div>
        ))}
        {st.partial ? (
          <div className="rt-line" data-who="user">
            <span className="rt-line__who">You</span>
            <span className="rt-line__text rt-partial">{st.partial}</span>
          </div>
        ) : null}
      </div>

      <Timeline view={st.session} />
    </section>
  );
}

/* ------------------------------------------------------------------ map */

function MapPane({ st, selectedId, onSelect, reduced }: { st: ControllerState; selectedId: string | null; onSelect: (id: string) => void; reduced: boolean }) {
  const claims = st.session.claims;
  const passages = useMemo(() => new Map(st.session.document.passages.map((p) => [p.id, p])), [st.session.document.passages]);
  const els = useRef(new Map<string, HTMLElement>());
  const pos = useRef(new Map<string, { x: number; y: number }>());

  // FLIP: a claim that changes band slides from where it was to where it is.
  // Offsets are relative to the bands container, so scrolling cannot fake a move.
  useLayoutEffect(() => {
    for (const [id, el] of els.current) {
      const next = { x: el.offsetLeft, y: el.offsetTop };
      const prev = pos.current.get(id);
      if (prev && !reduced && (prev.x !== next.x || prev.y !== next.y) && typeof el.animate === "function") {
        el.animate([{ transform: `translate(${prev.x - next.x}px, ${prev.y - next.y}px)` }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      }
      pos.current.set(id, next);
    }
  });

  const number = new Map(claims.map((c, i) => [c.id, i + 1]));
  return (
    <section className="rt-pane rt-map" aria-label="Defensibility map">
      <div className="rt-pane__head">
        <h2>Defensibility map</h2>
        <span className="rt-mono" style={{ color: "var(--rt-text-2)" }}>
          {claims.length} {claims.length === 1 ? "claim" : "claims"}
        </span>
      </div>
      <div className="rt-bands" style={{ position: "relative" }}>
        {STATUS_ORDER.map((status: ClaimStatus) => {
          const meta = STATUS_META[status];
          const inBand = claims.filter((c) => c.status === status);
          return (
            <section key={status} className="rt-band" data-status={status} aria-label={`${meta.label}, ${inBand.length}`} data-testid={`band-${status}`}>
              <div className="rt-band__head">
                <span className="rt-shape" data-shape={meta.shape} aria-hidden />
                <h3 className="rt-band__name">{meta.label}</h3>
                <span className="rt-band__count" data-testid={`count-${status}`}>
                  {inBand.length}
                </span>
              </div>
              {inBand.length === 0 ? (
                <p className="rt-band__empty">{meta.blurb}</p>
              ) : (
                <ul className="rt-cards">
                  {inBand.map((c) => {
                    const first = c.revisions[0];
                    const wasCorrected = c.revisions.some((r) => r.cause === "correction") && first.status !== c.status;
                    const changed = st.lastChange?.claimId === c.id;
                    const ids = [...c.contradictionPassageIds.map((id) => ({ id, against: true })), ...c.evidencePassageIds.map((id) => ({ id, against: false }))].slice(0, 4);
                    return (
                      <li key={c.id}>
                        <button
                          ref={(el) => {
                            if (el) els.current.set(c.id, el);
                            else els.current.delete(c.id);
                          }}
                          className="rt-card"
                          aria-pressed={selectedId === c.id}
                          data-status={c.status}
                          data-changed={changed ? "true" : undefined}
                          data-cut={c.awaitingCorrection ? "true" : undefined}
                          data-testid={`claim-${number.get(c.id)}`}
                          onClick={() => onSelect(c.id)}
                        >
                          <span className="rt-card__claim">
                            <span className="rt-mono" style={{ color: "var(--rt-text-2)", marginRight: 8 }}>
                              {number.get(c.id)}
                            </span>
                            {c.normalizedClaim}
                          </span>
                          <span className="rt-card__meta">
                            <span>{meta.label}</span>
                            {changed && st.lastChange ? (
                              <span className="rt-card__shift" data-testid="status-shift">
                                {STATUS_META[st.lastChange.from].label} → {STATUS_META[st.lastChange.to].label}
                              </span>
                            ) : wasCorrected ? (
                              <span className="rt-card__shift">was {STATUS_META[first.status].label.toLowerCase()}</span>
                            ) : null}
                            {c.awaitingCorrection ? <span className="rt-card__cut">cut off · awaiting your correction</span> : null}
                          </span>
                          <span className="rt-card__why">{c.basis}</span>
                          {ids.length ? (
                            <span className="rt-ev-chips">
                              {ids.map(({ id, against }) => (
                                <span key={id} className="rt-chip" aria-label={`${against ? "Contradicted by" : "Backed by"} ${cite(passages.get(id))}`}>
                                  {against ? "against" : "for"} {cite(passages.get(id))}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- room */

export function Room({ session, voice, onLeave }: { session: SessionView; voice: VoiceConfig; onLeave: () => void }) {
  const ctrl = useMemo(() => createController(httpApi, session), [session]);
  const st = useSyncExternalStore(ctrl.subscribe, ctrl.state, ctrl.state);
  const reduced = useReducedMotion();
  const audioRef = useRef<AudioHandle | null>(null);
  const [voiceLive, setVoiceLive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(true);
  const [finishing, setFinishing] = useState(false);

  const releaseAudio = useCallback(async () => {
    const a = audioRef.current;
    audioRef.current = null;
    setVoiceLive(false);
    await a?.stop();
  }, []);

  useEffect(
    () => () => {
      ctrl.cancel();
      void audioRef.current?.stop();
    },
    [ctrl]
  );

  // The socket ending or dying for good releases the microphone.
  const machineState = st.machine?.state;
  useEffect(() => {
    if (voiceLive && (machineState === "ENDED" || (machineState === "ERROR" && st.machine?.fatal))) void releaseAudio();
  }, [machineState, st.machine?.fatal, voiceLive, releaseAudio]);

  const startVoice = async () => {
    setLocalError(null);
    try {
      const audio = await openAudio();
      audioRef.current = audio;
      audio.onFrame((f) => ctrl.sendAudio(f));
      setVoiceLive(true);
      ctrl.startVoice(voice, { playAudio: audio.playback.play, flushAudio: audio.playback.flush });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "The microphone could not start. Type instead.");
    }
  };

  const stopVoice = async () => {
    await ctrl.stopVoice();
    await releaseAudio();
  };

  const finish = async () => {
    setFinishing(true);
    try {
      if (voiceLive) await stopVoice();
      await ctrl.end();
      setShowReport(true);
    } finally {
      setFinishing(false);
    }
  };

  const claims = st.session.claims;
  const active = claims.find((c) => c.id === (selectedId ?? st.session.activeClaimId)) ?? null;
  // When a verdict lands, the map follows it, so the source shows what decided it.
  useEffect(() => {
    if (st.lastChange) setSelectedId(st.lastChange.claimId);
  }, [st.lastChange]);
  useEffect(() => {
    const id = st.session.activeClaimId;
    if (id) setSelectedId(id);
  }, [st.session.activeClaimId, st.session.claims.length]);

  const markNumbers = useMemo(() => {
    const m = new Map<string, number[]>();
    claims.forEach((c, i) => {
      for (const id of [...c.evidencePassageIds, ...c.contradictionPassageIds]) m.set(id, [...(m.get(id) ?? []), i + 1]);
    });
    return m;
  }, [claims]);
  const askedIds = st.session.challenges.at(-1)?.groundedIn ?? [];

  if (st.report && showReport) {
    return (
      <div className="rt" data-testid="room">
        <Bar session={st.session} onLeave={onLeave} onFinish={null} finishing={false} />
        <ReportView report={st.report} onBack={() => setShowReport(false)} />
      </div>
    );
  }

  return (
    <div className="rt" data-testid="room">
      <Bar session={st.session} onLeave={onLeave} onFinish={st.report ? () => setShowReport(true) : null} finishing={false} />
      <div className="rt-tabs" role="tablist" aria-label="Review sections">
        {(["source", "review", "map"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} id={`tab-${t}`}>
            {t === "source" ? "Source" : t === "review" ? "Review" : "Map"}
          </button>
        ))}
      </div>
      <main id="main" className="rt-room" data-tab={tab}>
        <SourcePane view={st.session} selected={active} markNumbers={markNumbers} askedIds={askedIds} reduced={reduced} />
        <VoicePane st={st} ctrl={ctrl} audio={audioRef.current} voiceLive={voiceLive} onStartVoice={startVoice} onStopVoice={stopVoice} localError={localError} onFinish={finish} finishing={finishing} onShowMap={() => setTab("map")} />
        <MapPane
          st={st}
          selectedId={active?.id ?? null}
          reduced={reduced}
          onSelect={(id) => {
            setSelectedId(id);
            if (window.matchMedia("(max-width: 900px)").matches) setTab("source");
          }}
        />
      </main>
    </div>
  );
}

function Bar({ session, onLeave, onFinish, finishing }: { session: SessionView; onLeave: () => void; onFinish: (() => void) | null; finishing: boolean }) {
  return (
    <header className="rt-bar">
      <Link href="/" className="rt-brand">
        VIVA <b>RedTeam</b>
      </Link>
      <div className="rt-doc">
        <span className="rt-doc__title">{session.document.title}</span>
        {session.document.sample ? <span className="rt-tag rt-tag--sample">Sample material</span> : null}
      </div>
      <div className="rt-bar__actions">
        {onFinish ? (
          <button className="rt-btn" onClick={onFinish} disabled={finishing}>
            Show report
          </button>
        ) : null}
        <button className="rt-btn" onClick={onLeave}>
          New review
        </button>
      </div>
    </header>
  );
}
