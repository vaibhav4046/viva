"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/demo", label: "Study" },
  { href: "/memory", label: "Memory" },
  { href: "/exam", label: "Exam" },
  { href: "/learn", label: "Learn" },
];

export function Nav() {
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  const cluster = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Compact nav (<480px): close on route change so the panel never lingers.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Compact nav: Escape closes and returns focus; outside click closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const el = cluster.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  // Scroll state is written to a data attribute via rAF — no state, no re-render.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      el.dataset.scrolled = window.scrollY > 8 ? "true" : "false";
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <header
      ref={ref}
      className="sticky top-0 z-40 border-b hairline"
      style={{ background: "rgba(8,10,13,0.82)", backdropFilter: "blur(12px)" }}
    >
      <nav aria-label="Primary" className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-2 sm:px-5 sm:py-3">
        <Link href="/" className="flex min-h-11 items-center gap-2" aria-label="VIVA home">
          <img src="/brand/viva-mark.svg" alt="" width={26} height={26} aria-hidden />
          <span className="heading text-lg tracking-tight">VIVA</span>
        </Link>
        <div ref={cluster} className="relative flex flex-wrap items-center justify-end gap-x-0.5 gap-y-0.5 text-sm sm:gap-x-1.5">
          {/* >=480px: the five links, exactly as before. */}
          <div className="hidden min-[480px]:flex flex-wrap items-center justify-end gap-x-0.5 gap-y-0.5 sm:gap-x-1.5">
            {LINKS.map((l) => {
              const active = pathname === l.href || pathname.startsWith(l.href + "/");
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className="nav-link min-h-11 rounded-full px-2.5 text-[13px] sm:px-3.5 sm:text-sm"
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
          {/* <480px: one Menu disclosure; the panel closes on link click, Escape,
              route change and outside click. */}
          <button
            ref={menuButton}
            type="button"
            className="nav-link min-h-11 rounded-full px-3 text-[13px] min-[480px]:hidden!"
            aria-expanded={open}
            aria-controls="nav-compact"
            onClick={() => setOpen((o) => !o)}
          >
            Menu
          </button>
          {open ? (
            <div
              id="nav-compact"
              className="surface-card absolute right-0 top-full z-50 mt-1 flex w-44 flex-col p-1.5 min-[480px]:hidden!"
            >
              {LINKS.map((l) => {
                const active = pathname === l.href || pathname.startsWith(l.href + "/");
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className="nav-link min-h-11 w-full justify-start! rounded-lg px-3.5 text-sm"
                    onClick={() => setOpen(false)}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </div>
          ) : null}
          {pathname !== "/demo" ? (
            <Link href="/demo" className="btn-spectrum ml-1 inline-flex min-h-11 items-center !px-4 text-[13px] sm:!px-5 sm:text-sm">
              Try demo
            </Link>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
