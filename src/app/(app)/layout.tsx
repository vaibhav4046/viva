import { AppShell } from "@/components/AppShell";
import { MotionProvider } from "@/components/MotionProvider";

/**
 * Application routes: /oral, /study, /subjects, /today, /map, /exam.
 *
 * The route group changes no URLs; it exists so every app page gets the same
 * shell (one header, one mobile tab bar, one "Saved" state) without each page
 * mounting its own navigation.
 *
 * The <main> column lives here too, and pages render their content straight
 * into it. It used to be copy-pasted into every page, and three of the five
 * copies had drifted: the h1 left edge moved 168, 296, 292, 168 px as you
 * tabbed across the nav. One wrapper, one measure.
 *
 * Rendered per request. src/proxy.ts serves a `script-src 'nonce-...'
 * 'strict-dynamic'` policy, and only a dynamic document has Next's bootstrap
 * scripts stamped with that nonce; prerender these routes and the browser
 * blocks every chunk, so the page paints once and never hydrates.
 */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <MotionProvider>
      <AppShell>
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {children}
        </main>
      </AppShell>
    </MotionProvider>
  );
}
