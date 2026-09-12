"use client";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Scroll reveal for the landing rows.
 *
 * An IntersectionObserver and one class, rather than an animation library:
 * the landing is the first thing a judge loads and this keeps its own
 * JavaScript at a few hundred bytes. The CSS in globals.css declares the
 * revealed state as the default, so the row is visible with JS off and under
 * `prefers-reduced-motion`.
 */
export function Reveal({ children, delayMs = 0 }: { children: ReactNode; delayMs?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${delayMs}ms` }}>
      {children}
    </div>
  );
}
