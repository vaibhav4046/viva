"use client";
import { usePathname } from "next/navigation";
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { EXIT, FADE_ONLY, SPRING } from "@/lib/motion";

/**
 * Page transition. A template (not a layout) re-mounts on every navigation,
 * which is what gives each route its own enter animation.
 *
 * `LazyMotion` lives here rather than in the root layout so the whole tree —
 * landing included — gets the small `domAnimation` feature bundle instead of
 * the full one. `strict` keeps it that way: every animated component in `src/`
 * uses `m.*`, and a stray `motion.*` would silently pull the full bundle in.
 * With `strict` it throws in development instead, where we can still fix it.
 *
 * Transform and opacity only. Under reduced motion the travel is dropped and
 * only the cross-fade remains.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();

  return (
    <LazyMotion strict features={domAnimation}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={pathname}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0, transition: FADE_ONLY } : { opacity: 0, y: -8, transition: EXIT }}
          transition={reduced ? FADE_ONLY : SPRING}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
}
