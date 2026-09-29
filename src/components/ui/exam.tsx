import type { ReactNode } from "react";
import { PageMarkIcon } from "@/components/ui/icons";

/*
 * The product-specific components. They carry the identity of the interface, so
 * they are drawn first and shared: the landing excerpt, the recorded-exam
 * player, the /oral screen and the debrief sheet all render these, with real
 * data or clearly labelled fixture data.
 *
 * All of them are server-safe (no hooks, no client state).
 */

/** True machine state, in words. Announced politely; never a partial transcript delta. */
export function StateLine({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return (
    <p
      className="mono"
      style={{ color: "var(--text-secondary)", minHeight: "1.5em" }}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      {children}
    </p>
  );
}

/** The question is the hero of the exam screen: large, serif, generous measure. */
export function QuestionCard({ children, label = "Examiner" }: { children: ReactNode; label?: string }) {
  return (
    <section className="surface-card p-5 sm:p-6" aria-label={label}>
      <p className="eyebrow">{label}</p>
      <p
        className="mt-2"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(1.375rem, 1.1rem + 1.1vw, 1.875rem)",
          lineHeight: 1.25,
          maxWidth: "36ch",
          color: "var(--text-primary)",
        }}
      >
        {children}
      </p>
    </section>
  );
}

/**
 * A wrong statement, marked the way a marker would mark a script: a red pen
 * underline. text-decoration, not a coloured stripe, so it also reads in print.
 */
export function CorrectionMark({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        textDecorationLine: "underline",
        textDecorationColor: "var(--correction)",
        textDecorationThickness: "2px",
        textUnderlineOffset: "4px",
      }}
    >
      {children}
    </span>
  );
}

/**
 * The page the examiner read. The quote is verbatim from the learner's own
 * material and the matched span is highlighted; the method label says how it
 * was checked. Page number and passage id are set in mono.
 */
export function PassageCard({
  page,
  section,
  passageId,
  before = "",
  match,
  after = "",
  method,
}: {
  page: number;
  section?: string;
  passageId?: string;
  before?: string;
  match: string;
  after?: string;
  method: string;
}) {
  return (
    <figure className="passage-quoted rounded-md p-4" style={{ margin: 0 }}>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono inline-flex items-center gap-1.5" style={{ color: "var(--text-primary)" }}>
          <PageMarkIcon size={16} />
          <span>p. {page}</span>
        </span>
        {section ? <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{section}</span> : null}
        {passageId ? <span className="mono" style={{ color: "var(--text-muted)" }}>{passageId}</span> : null}
      </figcaption>
      <blockquote className="mt-2" style={{ margin: "8px 0 0", fontSize: "var(--fs-body-sm)", lineHeight: 1.6, maxWidth: "var(--measure)" }}>
        {before}
        <mark
          style={{
            background: "var(--success-tint)",
            color: "var(--text-primary)",
            textDecorationLine: "underline",
            textDecorationColor: "var(--success)",
            textDecorationThickness: "2px",
            textUnderlineOffset: "3px",
          }}
        >
          {match}
        </mark>
        {after}
      </blockquote>
      <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        {method}
      </p>
    </figure>
  );
}

/** Two channels, learner and examiner. Values are 0..1 RMS, supplied by the caller. */
export function LevelMeter({
  learner,
  examiner,
}: {
  learner: number;
  examiner: number;
}) {
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const row = (label: string, value: number) => (
    <div className="flex items-center gap-3">
      <span className="mono" style={{ width: "5.5rem", color: "var(--text-secondary)" }}>
        {label}
      </span>
      <div
        className="meter flex-1"
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp(value) * 100)}
      >
        <span style={{ transform: `scaleX(${clamp(value)})`, width: "100%" }} />
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      {row("You", learner)}
      {row("Examiner", examiner)}
    </div>
  );
}

/** A status chip: the only pill. Tint plus text colour plus a word, never colour alone. */
export function StatusChip({
  tone,
  children,
}: {
  tone: "success" | "correction" | "warning" | "info" | "neutral";
  children: ReactNode;
}) {
  const map = {
    success: ["var(--success-tint)", "var(--success)"],
    correction: ["var(--correction-tint)", "var(--correction)"],
    warning: ["var(--warning-tint)", "var(--warning)"],
    info: ["var(--info-tint)", "var(--info)"],
    neutral: ["var(--surface-2)", "var(--text-secondary)"],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <span
      className="mono inline-flex items-center"
      style={{ background: bg, color: fg, borderRadius: "var(--radius-pill)", padding: "2px 10px", fontWeight: 500 }}
    >
      {children}
    </span>
  );
}
