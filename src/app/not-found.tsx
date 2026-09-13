import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";

/**
 * 404.
 *
 * Without this file Next.js serves its own, and its own ships an inline
 * `body { background: #fff }` — so an unmatched address inside an obsidian
 * product handed the student a full-screen white sheet with black "404 | This
 * page could not be found.", no wordmark, no nav and nothing to click. It was
 * the one screen in VIVA the design system did not reach, and the students who
 * saw it were the ones who had already gone wrong once.
 *
 * It renders through `AppShell`, not a bespoke layout: the header, the thumb
 * bar and the five destinations are the way back, and reproducing them here
 * would be a sixth copy of the navigation that drifts on the first change.
 *
 * `force-dynamic` for the same reason as the app routes — src/proxy.ts serves
 * a `script-src 'nonce-…' 'strict-dynamic'` policy, and only a per-request
 * document carries the nonce on Next's bootstrap scripts.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Page not found · VIVA",
};

export default function NotFound() {
  return (
    <AppShell>
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        {/* Sized to its content, not to the column. A single sentence stretched
            across 1440 px is the same mistake /today was making. */}
        <section className="surface-card mt-6 max-w-xl p-6 sm:p-8">
          <p className="eyebrow">404</p>
          <h1 className="heading mt-2 text-2xl">This page isn&apos;t here.</h1>
          <p className="prose-measure mt-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            The address may have a typo in it, or the link may be older than the page it points at.
            Nothing you have said is lost — your subjects, your notes and your map are where you
            left them.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {/* One primary. The paper pill is what "start talking" looks like
                on the landing hero and on /today; lime belongs to the mic. */}
            <Link href="/study" className="btn-primary">
              Go to Study
            </Link>
            <Link href="/subjects" className="btn-ghost">
              Pick a subject
            </Link>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
