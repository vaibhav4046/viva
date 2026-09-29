"use client";
import { useEffect } from "react";
import { DebriefSheet } from "./DebriefSheet";
import { DEBRIEF_EMPTY } from "./model";
import type { DebriefState } from "./debriefClient";

/**
 * The debrief in every state it can be in: building (a fixed-size skeleton),
 * nothing to show, failed (with a retry), or ready. The skeleton matches the
 * sheet's footprint so the page does not jump when it fills.
 */
export function DebriefArea({ state, level = 2, onRetry }: { state: DebriefState; level?: 1 | 2; onRetry: () => void }) {
  useEffect(() => {
    if (state.status === "ready") document.getElementById("debrief-title")?.focus({ preventScroll: false });
  }, [state.status]);

  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <section className="debrief" role="status" aria-busy="true" aria-label="Building your debrief" style={{ minHeight: "26rem" }}>
        <p className="mono debrief-meta">Building your debrief from what was checked in this exam</p>
        <div className="skeleton" style={{ height: 28, width: "40%" }} />
        <div className="skeleton" style={{ height: 96 }} />
        <div className="skeleton" style={{ height: 96 }} />
      </section>
    );
  }

  if (state.status === "empty") {
    return (
      <section className="debrief" aria-labelledby="debrief-empty">
        <h2 id="debrief-empty" className="debrief-title" style={{ fontSize: "var(--fs-h2)" }}>Nothing to debrief yet</h2>
        <p>{DEBRIEF_EMPTY}</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="oral-alert" role="alert" aria-labelledby="debrief-error">
        <h2 id="debrief-error" className="oral-alert-title">The debrief could not be built</h2>
        <p>{state.message}</p>
        <div className="oral-alert-actions"><button type="button" className="btn-primary" onClick={onRetry}>Try again</button></div>
      </section>
    );
  }

  return <DebriefSheet debrief={state.debrief} level={level} />;
}
