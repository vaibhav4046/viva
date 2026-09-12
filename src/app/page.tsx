import Link from "next/link";
import { headers } from "next/headers";
import "./landing.css";

/*
 * VIVA landing — one viewport, no scroll.
 *
 * Deliberately a plain server component: no "use client", no animation
 * library, no hydration. The whole page is static markup + landing.css, and
 * the only JavaScript is /landing.js (~1 KB, no framework) for the mobile
 * menu. This is the first thing a judge loads, so it ships as close to zero
 * runtime as the app can get.
 *
 * The e2e golden path (scripts/e2e-golden.py) pins three things here:
 *   - an element with id="hero"
 *   - the string "VIVA REMEMBERS" inside it
 *   - a link named "Watch the misconception demo" that routes to /demo
 * Keep all three when editing copy.
 */

export const metadata = {
  title: "VIVA · The AI that learns how you think",
};

const NAV = [
  { href: "/", label: "Home", current: true },
  { href: "/today", label: "Today", current: false },
  { href: "/memory", label: "Memory", current: false },
  { href: "/exam", label: "Exam", current: false },
];

/** VIVA mark, inked for the paper circle: V-waveform + two cognition nodes. */
function Mark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path
        d="M14 18 L26 48 L32 33 L38 48 L50 18"
        fill="none"
        stroke="var(--color-graphite)"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="26" cy="21" r="3.2" fill="var(--color-signal)" />
      <circle cx="38" cy="21" r="3.2" fill="var(--color-signal)" />
    </svg>
  );
}

export default async function Home() {
  // Reading the per-request nonce (set in src/proxy.ts) makes this route
  // dynamic, which is what lets Next stamp its own bootstrap scripts with the
  // same nonce. Without it, `script-src 'strict-dynamic'` blocks /landing.js —
  // 'strict-dynamic' disables host allowlisting, so plain 'self' is not enough.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="vv-page">
      <div className="vv-bg" />

      {/* ---------------------------------------------------------- header */}
      <header className="vv-header">
        {/* prefetch={false}: this points at the route we are already on, so
            the default prefetch is a wasted round trip that the browser then
            aborts. Same for the "Home" nav item below. */}
        <Link href="/" className="vv-logo" aria-label="VIVA home" prefetch={false}>
          <Mark />
        </Link>

        <nav className="vv-nav" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="vv-nav-link"
              aria-current={n.current ? "page" : undefined}
              prefetch={n.current ? false : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <Link href="/demo" className="vv-signin">
          Start studying
        </Link>

        <button
          type="button"
          className="vv-burger"
          id="vv-burger"
          aria-label="Open menu"
          aria-expanded="false"
          aria-controls="vv-menu"
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      <div className="vv-overlay" id="vv-overlay" hidden />
      <nav className="vv-menu" id="vv-menu" aria-label="Mobile" hidden>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={n.current ? "page" : undefined}
            prefetch={n.current ? false : undefined}
          >
            {n.label}
          </Link>
        ))}
        <Link href="/demo" className="vv-menu-cta">
          Start studying
        </Link>
      </nav>

      {/* ------------------------------------------------------------ hero */}
      {/*
        id="main" is the target of the skip link in the root layout — without
        it that link points at nothing and axe reports a broken skip link.
        id="hero" stays on the inner block because the e2e golden path reads
        its text; one element cannot carry both ids.
      */}
      <main className="vv-hero" id="main">
        <div className="vv-hero-inner" id="hero">
          <h1 className="vv-headline">
            <span className="vv-dot">STUDY. SPEAK.</span>
            <span className="vv-dot vv-dot-lime">VIVA REMEMBERS.</span>
          </h1>

          <p className="vv-sub vv-anim" style={{ "--d": "0.28s" } as React.CSSProperties}>
            {/* Plain language on purpose. "Thought Mark" and "Misconception
                Graph" are internal names for the event store and the concept
                index; a student reading the landing has no reason to learn
                either one to understand what the product does. */}
            Explain what you are studying out loud. VIVA saves what you got wrong,
            shows you the passage it came from, and asks you again tomorrow.
          </p>

          <div className="vv-cta-row">
            <Link
              href="/today"
              className="vv-cta"
              style={{ "--d": "0.4s" } as React.CSSProperties}
            >
              Start a 10-minute lesson
            </Link>
            <Link
              href="/demo"
              className="vv-cta-alt vv-anim"
              style={{ "--d": "0.48s" } as React.CSSProperties}
            >
              Watch the misconception demo
            </Link>
          </div>
        </div>
      </main>


      {/*
        `async`, not `defer`: React 19 only hoists async scripts out of the
        component tree into <head>. A deferred one stays inside the hydrated
        tree, where React never executes it — the tag renders and nothing runs.
        landing.js guards on document.readyState, so head-hoisting is safe.
      */}
      <script src="/landing.js" nonce={nonce} async />
    </div>
  );
}
