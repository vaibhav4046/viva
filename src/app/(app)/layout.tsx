import { AppShell } from "@/components/AppShell";

/**
 * Application routes: /study, /subjects, /today, /map, /exam.
 *
 * The route group changes no URLs; it exists so every app page gets the same
 * shell — one header, one mobile tab bar, one "Saved" state — without each
 * page mounting its own navigation.
 *
 * Rendered per request. src/proxy.ts serves a `script-src 'nonce-…'
 * 'strict-dynamic'` policy, and only a dynamic document has Next's bootstrap
 * scripts stamped with that nonce — prerender these routes and the browser
 * blocks every chunk, so the page paints once and never hydrates. These pages
 * all fetch per-learner data on mount anyway, so there is nothing to cache.
 */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
