"use client";

/**
 * Error banner with an explicit retry affordance. role=alert for SR users;
 * the coral rule is paired with the "Error" label, never colour alone.
 */
export function ErrorBanner({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="surface-card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm"
      style={{ borderLeft: "2px solid var(--color-coral)" }}
    >
      <p className="min-w-0" style={{ color: "var(--color-mist)" }}>
        <span className="mono mr-2 text-[11px] font-semibold tracking-widest" style={{ color: "var(--color-coral)" }}>
          ERROR
        </span>
        {message}
      </p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-ghost !px-4 !py-1.5 shrink-0 text-xs">
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
