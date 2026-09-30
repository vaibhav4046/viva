"use client";
import { LazyMotion, domAnimation } from "motion/react";

/**
 * The small `domAnimation` feature bundle for the screens that animate. It sits
 * in the (app) layout and not in the root layout, so `/` ships none of it.
 * `strict` keeps it small: every animated component in src/ uses `m.*`, and a
 * stray `motion.*` throws in development instead of pulling in the full bundle.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion strict features={domAnimation}>
      {children}
    </LazyMotion>
  );
}
