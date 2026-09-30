import Link from "next/link";
import type { ReactNode } from "react";
import { MarkIcon } from "@/components/ui/icons";

/**
 * Frame for the pages that are not the working app: recorded exam, privacy,
 * terms, accessibility, about. A brand link, three plain links and a single
 * <main>. The footer comes from the root layout.
 */
export function PublicShell({ children, width = "prose" }: { children: ReactNode; width?: "prose" | "wide" }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b hairline" style={{ background: "var(--canvas)" }}>
        <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2" aria-label="VIVA home">
            <MarkIcon size={22} />
            <span className="heading text-xl">VIVA</span>
          </Link>
          <div className="flex items-center gap-0.5">
            <Link href="/oral" className="nav-link">Oral exam</Link>
            <Link href="/subjects" className="nav-link">Your material</Link>
          </div>
        </nav>
      </header>
      <main
        id="main"
        className="legal mx-auto w-full flex-1 px-4 py-8 sm:px-6"
        style={{ maxWidth: width === "wide" ? "72rem" : "46rem" }}
      >
        {children}
      </main>
    </div>
  );
}

/** The opening line every legal page carries, verbatim from the brief. */
export function DraftNotice() {
  return (
    <p
      className="surface-card px-4 py-3 text-sm"
      style={{ background: "var(--warning-tint)", borderColor: "var(--warning)", color: "var(--text-primary)" }}
    >
      Hackathon draft. Not legal advice. Sections marked [NEEDS LEGAL REVIEW] must be reviewed
      by a qualified professional before a public launch.
    </p>
  );
}
