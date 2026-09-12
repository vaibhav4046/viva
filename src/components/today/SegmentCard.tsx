"use client";
import { useId } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { InlineRecall } from "./InlineRecall";
import type { PathSegment } from "./types";

const KIND: Record<PathSegment["kind"], { label: string; color: string }> = {
  misconception: { label: "MISCONCEPTION", color: "var(--color-band-mixed)" },
  weak_concept: { label: "WEAK CONCEPT", color: "var(--color-band-getting)" },
  recall: { label: "RECALL", color: "var(--color-cognition)" },
  teachback: { label: "TEACHBACK", color: "var(--color-band-getting)" },
  summary: { label: "SUMMARY", color: "var(--color-ash)" },
};

/**
 * One Daily Path segment: minutes chip, kind label, concept, why line, action.
 * recall/misconception open an inline recall on this page — mic first, typed
 * underneath — and the other kinds hand off to /study or /exam with the
 * selected course threaded through so the right subject opens.
 *
 * `open` is owned by the page rather than by the card: only one recall may be
 * open at a time, because each one mounts a mic and a mic owns the Space key.
 */
export function SegmentCard({
  index,
  segment,
  courseId,
  open,
  onToggle,
  onStart,
  onAnswered,
}: {
  index: number;
  segment: PathSegment;
  courseId?: string;
  open: boolean;
  onToggle: () => void;
  onStart?: (minutes: number) => void;
  onAnswered?: () => void;
}) {
  const panelId = useId();
  const kind = KIND[segment.kind];
  const inline = segment.kind === "misconception" || segment.kind === "recall";
  const courseParam = courseId ? `?course=${encodeURIComponent(courseId)}` : "";
  const teachHref = `/exam?mode=teach${courseId ? `&course=${encodeURIComponent(courseId)}` : ""}`;
  const studyHref = `/study${courseParam}`;

  return (
    <article className="surface-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="mono inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border hairline text-[11px]"
            style={{ color: kind.color }}
          >
            {index}
          </span>
          <span className="mono text-[11px] font-semibold tracking-widest" style={{ color: kind.color }}>
            {kind.label}
          </span>
        </div>
        <span className="chip">
          {segment.minutes} min
        </span>
      </div>

      {segment.conceptName ? (
        <h3 className="heading mt-3 text-lg leading-snug">{segment.conceptName}</h3>
      ) : (
        <h3 className="heading mt-3 text-lg leading-snug">Write it down</h3>
      )}
      <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
        {segment.why}
      </p>

      <div className="mt-3">
        {inline && segment.conceptId ? (
          <button
            type="button"
            className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => {
              onStart?.(segment.minutes);
              onToggle();
            }}
          >
            <Mic size={15} aria-hidden />
            {open ? "Hide" : "Say what you remember"}
          </button>
        ) : segment.kind === "teachback" ? (
          <Link
            href={teachHref}
            onClick={() => onStart?.(segment.minutes)}
            className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm"
          >
            Teach it back in Exam →
          </Link>
        ) : segment.kind === "weak_concept" ? (
          <Link href={studyHref} onClick={() => onStart?.(segment.minutes)} className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm">
            Open Study →
          </Link>
        ) : (
          <Link href={studyHref} onClick={() => onStart?.(segment.minutes)} className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm">
            Write it in Study →
          </Link>
        )}
      </div>

      {inline && open && segment.conceptId ? (
        <div id={panelId} className="mt-3">
          <InlineRecall
            conceptId={segment.conceptId}
            conceptName={segment.conceptName ?? segment.conceptId}
            courseId={courseId}
            onAnswered={onAnswered}
          />
        </div>
      ) : null}
    </article>
  );
}
