"use client";
import { useState } from "react";
import type { WeekDay } from "./types";

/**
 * "Your week" — a compact 7-day strip projected from the learner's current
 * review state (GET /api/learner/week). Today's count mirrors the path below;
 * clicking a day with due items scrolls to it. Pure presentation: the route
 * owns the projection rules.
 */
export function WeekStrip({ days }: { days: WeekDay[] }) {
  const [picked, setPicked] = useState<string | null>(null);

  const jumpToPath = (day: WeekDay) => {
    setPicked(day.date);
    if (typeof document !== "undefined") {
      document.getElementById("path-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <section aria-labelledby="week-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="week-heading" className="heading text-xl">
          Your week
        </h2>
        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
          Projected from your current review state
        </span>
      </div>
      <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((day, i) => (
          <li key={day.date}>
            <button
              type="button"
              disabled={day.count === 0}
              aria-pressed={picked === day.date}
              aria-label={`${day.label} ${day.date}: ${day.count} due${day.segments[0] ? `, first ${day.segments[0].title}` : ""}`}
              onClick={() => jumpToPath(day)}
              className="surface-card week-chip flex h-full w-full flex-col gap-1 p-3 text-left transition-opacity disabled:opacity-50"
              style={{ animationDelay: `${Math.min(i, 11) * 60}ms` }}
            >
              <span className="mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ash)" }}>
                {day.label}
              </span>
              <span
                className="heading text-2xl"
                style={{ color: day.count > 0 ? "var(--color-band-getting)" : "var(--color-ash)" }}
              >
                {day.count}
              </span>
              <span className="text-xs leading-snug" style={{ color: "var(--color-mist)" }}>
                {day.segments[0]?.title ?? "Nothing projected"}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
