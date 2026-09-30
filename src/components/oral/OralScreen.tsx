"use client";
import type { ReactNode } from "react";
import { QuestionCard, StateLine } from "@/components/ui/exam";
import { KeyboardIcon, MicrophoneIcon, StopIcon } from "@/components/ui/icons";
import type { OralState } from "@/lib/oral/machine";
import { LiveMeter } from "./LiveMeter";
import { Clock, FailurePanel, HeadphoneNote, SourcesColumn, Transcript } from "./OralParts";
import type { OralTurn } from "./mic";
import { SHORTCUT_LABEL, controlsFor, stateHint, stateLine, type FailureAction, type FailureView, type Phase, type SourceCard } from "./model";
import "./oral.css";

/**
 * The exam screen, as a function of props. The live page feeds it from
 * useOralSession; /dev/oral-states feeds it fixtures for every state, so the
 * screenshot matrix and axe can visit each one.
 */
export type OralScreenProps = {
  phase: Phase;
  state: OralState;
  fatal?: boolean;
  /** Page of the most recent check, once its result is in. */
  page?: number | null;
  startedAt: number | null;
  counts: { turns: number; toolCalls: number; interruptions: number };
  examinerText: string;
  examinerCut?: boolean;
  learnerText: string;
  lines: OralTurn[];
  sources: SourceCard[];
  failure: FailureView | null;
  notice: FailureView | null;
  readLevels?: () => { learner: number; examiner: number };
  fixedLevels?: { learner: number; examiner: number };
  /** When set, the typed exam replaces the question card and the controls. */
  typedSlot?: ReactNode;
  debriefSlot?: ReactNode;
  diagSlot?: ReactNode;
  canDebrief?: boolean;
  onStart: () => void;
  onEnd: () => void;
  onTypeInstead: () => void;
  onFailureAction: (a: FailureAction) => void;
  onDebrief?: () => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function OralScreen(p: OralScreenProps) {
  const state = p.phase === "idle" && p.state !== "ERROR" ? "IDLE" : p.state;
  const controls = controlsFor(p.phase, state, p.fatal ?? false);
  const stopped = p.phase !== "running";
  const line = p.typedSlot ? "Typing" : stateLine(state, { phase: p.phase, page: p.page });
  const hint = p.typedSlot
    ? "You are answering in writing. The microphone is off."
    : p.phase === "loading"
      ? "Fetching your subject and opening the exam."
      : stateHint(state, p.phase === "ended" ? "ended" : p.phase === "idle" ? "idle" : "running");
  const question = p.examinerText.trim();
  const startLabel = p.phase === "ended" || state === "ENDED" ? "Start another exam" : p.failure ? "Start again" : "Start the exam";

  return (
    <div className="oral">
      <div className="oral-head">
        <h1 className="oral-h1">Oral exam</h1>
        <Clock startedAt={p.startedAt} />
      </div>

      {p.failure ? <FailurePanel view={p.failure} onAction={p.onFailureAction} onDebrief={p.canDebrief ? p.onDebrief : undefined} /> : null}
      {!p.failure && p.notice ? <FailurePanel view={p.notice} onAction={p.onFailureAction} /> : null}

      <section className="oral-strip" aria-label="Exam status">
        <div className="oral-state-wrap oral-state">
          <StateLine live>{line}</StateLine>
          <p className="oral-hint">{hint}</p>
        </div>
        <LiveMeter read={p.readLevels} fixed={p.fixedLevels} />
      </section>

      <div className="oral-desk">
        <div className="oral-main">
          {p.typedSlot ?? (
            <>
              <div className="oral-question">
                <QuestionCard label="Examiner">
                  {question ? (
                    question
                  ) : (
                    <span className="oral-question-muted">
                      {p.phase === "running" ? "Waiting for the examiner to speak." : "Your examiner opens the exam and asks what you want to be examined on."}
                    </span>
                  )}
                </QuestionCard>
                {p.examinerCut && question ? <p className="mono oral-cut">You cut in here. The examiner dropped the rest of the sentence.</p> : null}
              </div>
              {p.phase === "idle" || p.phase === "ended" ? <HeadphoneNote /> : null}
              {p.phase !== "idle" || p.learnerText ? (
                <section className="oral-line" aria-label="Your words">
                  <p className="eyebrow">You</p>
                  <p className={p.learnerText ? undefined : "oral-line-empty"}>{p.learnerText || "Waiting for you to speak."}</p>
                </section>
              ) : null}
              <Transcript lines={p.lines} />
            </>
          )}
        </div>
        <SourcesColumn sources={p.sources} live={!stopped} />
      </div>

      {p.diagSlot}

      {p.typedSlot ? null : (
        <div className="oral-controls" role="group" aria-label="Exam controls">
          {p.phase === "loading" ? (
            <button type="button" className="btn-primary" disabled aria-busy="true">
              <MicrophoneIcon size={20} />
              Opening the exam
            </button>
          ) : null}
          {controls.start ? (
            <button type="button" className="btn-primary" onClick={p.onStart}>
              <MicrophoneIcon size={20} />
              {startLabel}
            </button>
          ) : null}
          {controls.end ? (
            <button type="button" className="btn-primary" onClick={p.onEnd}>
              <StopIcon size={20} />
              End the exam
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={p.onTypeInstead}>
            <KeyboardIcon size={20} />
            Type instead
          </button>
          <p className="oral-shortcut">
            <kbd className="oral-kbd">{SHORTCUT_LABEL}</kbd> starts or ends the exam.
          </p>
          {p.phase === "running" ? (
            <p className="mono oral-counts">
              {plural(p.counts.turns, "answer", "answers")}, {plural(p.counts.toolCalls, "source check", "source checks")}
              {p.counts.interruptions > 0 ? `, ${plural(p.counts.interruptions, "interruption", "interruptions")}` : ""}
            </p>
          ) : null}
        </div>
      )}

      {p.debriefSlot}
    </div>
  );
}
