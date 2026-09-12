/**
 * Passthrough layout for the application routes.
 *
 * This route group changes no URLs: /demo, /exam, /learn, /memory and /today
 * are unaffected by the "(app)" segment. It exists purely to keep that
 * grouping in place now that the auth provider it used to mount is gone —
 * identity is the HttpOnly `viva_did` cookie, resolved server-side.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
