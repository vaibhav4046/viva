import type { ReactNode } from "react";

/**
 * The one page header. Optional eyebrow in plain words (no curly braces), a
 * clamped H1, one line of description, optional actions. Static: nothing here
 * fades or shifts under the reader.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="heading mt-1 text-[clamp(1.5rem,4vw,2rem)]">{title}</h1>
        {description ? (
          <p className="prose-measure mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>
      ) : null}
    </div>
  );
}
