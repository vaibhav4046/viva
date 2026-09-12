"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BookOpen, CalendarCheck, CircleHelp, Layers, Network, Plug } from "lucide-react";

/**
 * The one shell. Every page inside the app group renders through this: a
 * single header on desktop, a single bottom tab bar on mobile, and the same
 * five destinations in the same order in both.
 *
 * It replaces two competing header systems (a cream pill nav on the landing
 * and a dark bar in the app) and three different names for the study screen
 * ("Enter VIVA", "Try demo", "Study"). One name each, everywhere.
 *
 * Connect is the one link that is not a daily destination — you pair an
 * assistant once and never come back. It sits in the header, and is left out
 * of the thumb bar so the five places a student actually goes keep their
 * width on a 320 px phone.
 */

const LINKS = [
  { href: "/study", label: "Study", Icon: BookOpen },
  { href: "/subjects", label: "Subjects", Icon: Layers },
  { href: "/today", label: "Today", Icon: CalendarCheck },
  { href: "/map", label: "Map", Icon: Network },
  { href: "/exam", label: "Quiz", Icon: CircleHelp },
  // headerOnly keeps the thumb bar at five destinations on a 320 px phone.
  // Connect is still reachable there: the footer link below is not md:-gated,
  // because a link with no entry point on the device most study happens on is
  // a feature nobody can find.
  { href: "/connect", label: "Connect", Icon: Plug, headerOnly: true },
] as const;

const TAB_LINKS = LINKS.filter((l) => !("headerOnly" in l && l.headerOnly));

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * "Saved" state. Any page can announce a write with
 * `window.dispatchEvent(new Event("viva:saved"))`; the word fades in for a
 * few seconds and then leaves. This is what replaces the yellow storage
 * banner: a student is told their work is kept, never told which backend
 * kept it.
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
      className="mono text-xs transition-opacity"
      style={{ color: "var(--color-ash)", opacity: shown ? 1 : 0, transitionDuration: "var(--dur-base)" }}
    >
      {shown ? "Saved" : ""}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-40 border-b hairline"
        style={{ background: "color-mix(in srgb, var(--color-obsidian) 88%, transparent)", backdropFilter: "blur(12px)" }}
      >
        <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
          <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2" aria-label="VIVA home">
            <img src="/brand/viva-mark.svg" alt="" width={24} height={24} aria-hidden />
            <span className="heading text-lg tracking-tight">VIVA</span>
          </Link>

          {/* Desktop: the five destinations inline. Mobile gets the tab bar. */}
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

      <div className="flex-1 pb-20 md:pb-0">
        {children}

        {/* Connect is not a daily destination, so it does not earn a thumb-bar
            slot on a 320 px phone. It still has to be reachable there: the
            header nav that holds it is md:-only, and a page nobody on a phone
            can find is a page that does not exist. */}
        <div className="mx-auto w-full max-w-6xl px-4 pb-6 pt-2 sm:px-6 md:hidden">
          <Link
            href="/connect"
            className="mono inline-flex min-h-11 items-center gap-2 text-xs"
            style={{ color: "var(--color-ash)" }}
          >
            <Plug size={14} aria-hidden strokeWidth={1.8} />
            Use VIVA from another assistant
          </Link>
        </div>
      </div>

      {/* Mobile bottom tabs. Fixed so the destinations are always one thumb
          away, and padded for the home indicator.

          Its own name, not the header's. Only one of the two navs is visible at
          a time, but both are in the accessibility tree at every width, and two
          landmarks called "Primary" leave a screen-reader user choosing between
          two identical entries in the landmark list. */}
      <nav
        aria-label="Primary tabs"
        className="fixed inset-x-0 bottom-0 z-40 border-t hairline md:hidden"
        style={{
          background: "color-mix(in srgb, var(--color-obsidian) 94%, transparent)",
          backdropFilter: "blur(12px)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <ul className="flex items-stretch justify-around">
          {TAB_LINKS.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className="flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px]"
                  style={{ color: active ? "var(--color-paper)" : "var(--color-ash)", fontWeight: active ? 600 : 400 }}
                >
                  <Icon size={20} aria-hidden strokeWidth={active ? 2.2 : 1.8} />
                  {label}
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
