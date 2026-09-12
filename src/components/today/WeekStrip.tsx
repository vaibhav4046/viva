"use client";
import { useState } from "react";
import type { WeekDay } from "@/lib/planner";

/**
 * "Your week" — seven days projected from the learner's current review state.
 * Today's count mirrors the path above because it is the same object: both come
 * out of one projectWeek() call over one snapshot. Clicking a day with
 * something in it scrolls back to the plan.
 *
 * A day with nothing due is a one-line row, not a card. The strip used to give
 * every day the same 107 px card, and on a cold account five of the seven read
 * "0 / Nothing projected" — 546 px of null data that pushed the ten-minute
 * path, the reason the page exists, below the fold on a phone. Weight now goes
 * to the days that have something in them.
 *
 * Pure presentation: the route owns the projection rules.
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
    <section aria-labelledby="week-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="week-heading" className="heading text-xl">
          Your week
        </h2>
        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
          Projected from your current review state
        </span>
      </div>
      <ol className="mt-3 space-y-1.5">
        {days.map((day) =>
          day.count === 0 ? (
            <li key={day.date} className="flex min-h-7 items-center gap-3 px-1">
              <span className="mono w-20 shrink-0 text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ash)" }}>
                {day.label}
              </span>
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--color-hairline)" }}
              />
              <span className="truncate text-xs" style={{ color: "var(--color-ash)" }}>
                Nothing projected
              </span>
            </li>
          ) : (
            <li key={day.date}>
              <button
                type="button"
                aria-pressed={picked === day.date}
                aria-label={`${day.label} ${day.date}: ${day.count} due${day.segments[0] ? `, first ${day.segments[0].title}` : ""}`}
                onClick={() => jumpToPath(day)}
                className="surface-card flex min-h-11 w-full items-center gap-3 p-3 text-left transition-colors hover:border-[var(--color-cognition)]"
              >
                <span className="mono w-20 shrink-0 text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ash)" }}>
                  {day.label}
                </span>
                <span className="heading tnum shrink-0 text-2xl" style={{ color: "var(--color-band-getting)" }}>
                  {day.count}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--color-mist)" }}>
                  {day.segments[0]?.title ?? ""}
                </span>
              </button>
            </li>
          )
        )}
      </ol>
    </section>
  );
}
