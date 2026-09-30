"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MarkIcon } from "@/components/ui/icons";

/**
 * The one shell. Every page inside the app group renders through this: a
 * single header on desktop, a single bottom tab bar on mobile, and the same
 * destinations in the same order in both. Text labels only: a destination is a
 * word, and a word needs no icon library.
 *
 * Connect is the one link that is not a daily destination, since you pair an
 * assistant once and never come back. It sits in the header and is left out of
 * the thumb bar so the five places a student actually goes keep their width on
 * a 320 px phone.
 */

const LINKS: readonly { href: string; label: string; short?: string; headerOnly?: boolean }[] = [
  { href: "/oral", label: "Oral exam", short: "Oral" },
  { href: "/study", label: "Study" },
  { href: "/subjects", label: "Subjects" },
  { href: "/today", label: "Today" },
  { href: "/map", label: "Map", headerOnly: true },
  { href: "/exam", label: "Quiz" },
  // headerOnly keeps the thumb bar at five destinations on a 320 px phone.
  // Map and Connect are still reachable there: the footer links below are not md:-gated.
  { href: "/connect", label: "Connect", headerOnly: true },
];

const TAB_LINKS = LINKS.filter((l) => !l.headerOnly);

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * "Saved" state. Any page can announce a write with
 * `window.dispatchEvent(new Event("viva:saved"))`; the word shows for a few
 * seconds and then leaves. A student is told their work is kept, never which
 * backend kept it.
 */
function SavedState() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSaved = () => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), 2600);
    };
    window.addEventListener("viva:saved", onSaved);
    return () => {
      window.removeEventListener("viva:saved", onSaved);
      clearTimeout(timer);
    };
  }, []);
  return (
    <span
      aria-live="polite"
      className="mono transition-opacity"
      style={{ color: "var(--text-muted)", opacity: shown ? 1 : 0, transitionDuration: "var(--dur-base)" }}
    >
      {shown ? "Saved" : ""}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 border-b hairline" style={{ background: "var(--canvas)", zIndex: "var(--z-nav)" }}>
        <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
          <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2" aria-label="VIVA home">
            <MarkIcon size={22} />
            <span className="heading text-xl tracking-tight">VIVA</span>
          </Link>

          {/* Desktop: the destinations inline. Mobile gets the tab bar. */}
          <div className="ml-2 hidden items-center gap-0.5 md:flex">
            {LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="nav-link"
                aria-current={isActive(pathname, href) ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <SavedState />
          </div>
        </nav>
      </header>

      {/* The thumb bar is 57 px plus the home indicator; pb-28 keeps the last
          control on a page clear of it. */}
      <div className="flex-1 pb-28 md:pb-0">
        {children}

        {/* A <footer>, not a <div>: <main> lives inside {children}, so this
            sits outside every landmark and axe rightly calls that a region
            violation. */}
        <footer className="mx-auto w-full max-w-6xl px-4 pb-6 pt-2 sm:px-6 md:hidden">
          <Link href="/map" className="link mono inline-flex min-h-11 items-center pr-4">
            Concept map
          </Link>
          <Link href="/connect" className="link mono inline-flex min-h-11 items-center">
            Use VIVA from another assistant
          </Link>
        </footer>
      </div>

      {/* Mobile bottom tabs. Fixed so the destinations are always one thumb
          away, padded for the home indicator. Its own name, not the header's:
          both navs are in the accessibility tree at every width. */}
      <nav
        aria-label="Primary tabs"
        data-tabbar
        className="fixed inset-x-0 bottom-0 border-t hairline md:hidden"
        style={{
          background: "var(--canvas)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: "var(--z-nav)",
        }}
      >
        <ul className="flex items-stretch justify-around">
          {TAB_LINKS.map((link) => {
            const { href, label } = link;
            const text = link.short ?? label;
            const active = isActive(pathname, href);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className="flex min-h-[56px] items-center justify-center px-1 py-1.5 text-[0.8125rem]"
                  style={{
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: active ? 600 : 400,
                    textDecoration: active ? "underline" : "none",
                    textDecorationThickness: "2px",
                    textUnderlineOffset: "6px",
                  }}
                >
                  {text}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** Announce a successful write to the shell's "Saved" state. */
export function announceSaved(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("viva:saved"));
}
