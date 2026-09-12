"use client";
import { ExternalLink } from "lucide-react";
import type { SourceLicence } from "@/lib/courses/types";

/*
 * Who wrote the words a student is reading.
 *
 * The library subjects are chapters of openly licensed textbooks, and showing
 * the credit is the condition on using them at all — not a footnote VIVA can
 * decide to skip. So this renders wherever borrowed passages are offered or
 * read, and it renders the credit exactly as the licence supplies it: a
 * rewritten credit is not the credit.
 *
 * Quiet on purpose. Ash, 11 px, under a hairline, below whatever it belongs to.
 * A subject a student picked because of its title should still be read as its
 * title first.
 */

/** "openstax.org" — the part of an address a person recognises. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** What the licence asks VIVA to say beyond the credit, in plain words. */
function conditionsOf(l: SourceLicence): string | null {
  const parts: string[] = [];
  if (l.shareAlike) parts.push("Anything built on it carries the same licence.");
  if (l.nonCommercial) parts.push("It may not be used to make money.");
  return parts.length ? parts.join(" ") : null;
}

const LINK = "underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--color-cognition)]";

export function Attribution({
  licences,
  className = "",
}: {
  licences: SourceLicence[];
  /** Where the caller wants the rule and the spacing. */
  className?: string;
}) {
  if (!licences.length) return null;
  return (
    <div className={`grid gap-3 ${className}`} aria-label="Where this material came from">
      {licences.map((l) => {
        const host = hostOf(l.sourceUrl);
        const conditions = conditionsOf(l);
        return (
          <div key={`${l.name}-${l.sourceUrl}`} className="min-w-0">
            <p
              className="text-[11px] leading-relaxed"
              style={{ color: "var(--color-ash)", overflowWrap: "anywhere" }}
            >
              {l.attribution}
              {conditions ? ` ${conditions}` : null}
            </p>
            <p className="mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--color-ash)" }}>
              <a href={l.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                {l.name}
              </a>
              <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className={`${LINK} inline-flex items-center gap-1`}>
                {host ? `Read the original at ${host}` : "Read the original"}
                <ExternalLink size={11} aria-hidden />
              </a>
            </p>
          </div>
        );
      })}
    </div>
  );
}
