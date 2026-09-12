import type { ReactNode } from "react";

/**
 * Unified app-page header: eyebrow (curly-brace), clamped title, one-line
 * description, optional actions. Used by /demo, /exam, /learn, /today,
 * /memory. Static: no entrance animation, so nothing about the header can
 * shift or fade in under the reader. `rule` adds the /today 44×2px warm
 * spectrum rule under the H1.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  rule = false,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  rule?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <p className="eyebrow">
          {eyebrow}
        </p>
        <h1 className="heading mt-1 text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.02]">
          {title}
        </h1>
        {rule ? <span className="spectrum-rule mt-3" aria-hidden /> : null}
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
