"use client";
import type { CSSProperties, ReactNode } from "react";

/**
 * The orb is gone. The Examiner's table design has no orb, no glow and no
 * drifting field: the state of the exam is said in words (the state line) and
 * measured on the level meter.
 *
 * Two things are kept so the screens that still import from here compile:
 *  - `OrbSlot` renders its children in a plain box, and nothing when it has none.
 *  - `setOrbLevel` and `setOrbAnalyser` stay as the level feed the mic button
 *    writes to. The level meter reads the same values.
 *
 * Callers should stop importing this file when their screen is rebuilt.
 */
export function OrbSlot({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  priority?: number;
  children?: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

export { setOrbLevel, setOrbAnalyser } from "./orbState";
