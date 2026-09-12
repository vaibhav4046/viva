import { AppShell } from "@/components/AppShell";
import { OrbBackdrop } from "@/components/orb/Orb";

/**
 * Application routes: /study, /subjects, /today, /map, /exam.
 *
 * The route group changes no URLs; it exists so every app page gets the same
 * shell — one header, one mobile tab bar, one "Saved" state — without each
 * page mounting its own navigation.
 *
 * The <main> column lives here too, and pages render their content straight
 * into it. It used to be copy-pasted into every page, and three of the five
 * copies had drifted: the h1 left edge moved 168 → 296 → 292 → 168 px as you
 * tabbed across the nav, which is the one thing a single shell is supposed to
 * make impossible. One wrapper, one measure, and a sixth page cannot
 * re-invent it.
 *
 * Rendered per request. src/proxy.ts serves a `script-src 'nonce-…'
 * 'strict-dynamic'` policy, and only a dynamic document has Next's bootstrap
 * scripts stamped with that nonce — prerender these routes and the browser
 * blocks every chunk, so the page paints once and never hydrates. These pages
 * all fetch per-learner data on mount anyway, so there is nothing to cache.
 */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <OrbBackdrop>
      <AppShell>
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {children}
        </main>
      </AppShell>
    </OrbBackdrop>
  );
}
