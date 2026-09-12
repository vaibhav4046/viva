/**
 * Honest loading block: a status line the screen reader announces plus
 * skeleton bars. Not a spinner that implies progress it cannot know.
 */
export function LoadingBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" className="surface-card p-4">
      <p className="mono text-xs" style={{ color: "var(--color-ash)" }}>
        {label}
      </p>
      <div className="mt-3 space-y-2" aria-hidden>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="skeleton h-3"
            style={{ width: `${[100, 82, 64, 74][i % 4]}%` }}
          />
        ))}
      </div>
    </div>
  );
}
