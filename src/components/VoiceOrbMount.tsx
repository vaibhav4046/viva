"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * Decides whether the orb is worth loading, and paints something honest while
 * it decides.
 *
 * three.js is the single heaviest thing VIVA could ship, so it is never in the
 * first paint: the fallback below is a CSS radial gradient with the same
 * silhouette and the same lime, and the real canvas replaces it only once the
 * page is interactive, WebGL answers, and the reader has not asked for less
 * motion. Nothing above the fold depends on it.
 */

const VoiceOrb = dynamic(() => import("@/components/three/VoiceOrb"), {
  ssr: false,
  loading: () => null,
});

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function VoiceOrbMount({ level = 0, className = "" }: { level?: number; className?: string }) {
  const [show, setShow] = useState(false);
  const [detail, setDetail] = useState(5);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!hasWebGL()) return;

    /*
     * Phones never load three at all.
     *
     * Measured on the deployed landing before this guard: mobile Lighthouse
     * Performance 66, total blocking time 1,110 ms, 2.0 s of script bootup,
     * with a single 239 KB chunk — three.js — dominating a 430 KB payload.
     * A 250 ms delay does not help: the download and parse still land inside
     * the window the score measures, and on a real mid-range phone that is a
     * second of unresponsiveness for decoration.
     *
     * The gradient fallback carries the same silhouette and the same lime, so
     * the page still looks composed; the orb is a desktop flourish and is
     * treated as one. Also skipped on a metered or 2g/3g connection.
     */
    if (window.matchMedia("(max-width: 767px)").matches) return;

    type NetworkInfo = { saveData?: boolean; effectiveType?: string };
    const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
    if (conn?.saveData) return;
    if (conn?.effectiveType && /(^|-)(2g|3g)$/.test(conn.effectiveType)) return;

    setDetail(5);

    /*
     * Wait for the main thread to be genuinely idle rather than guessing with
     * a timer, so the import can never compete with hydration or LCP.
     */
    const start = () => setShow(true);
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === "function") {
      const handle = ric(start, { timeout: 3000 });
      return () => {
        const cancel = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
        cancel?.(handle);
      };
    }
    const id = window.setTimeout(start, 1200);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className={className} aria-hidden>
      {show ? (
        <VoiceOrb level={level} detail={detail} />
      ) : (
        <OrbSilhouette />
      )}
    </div>
  );
}

/**
 * The phone's orb.
 *
 * three.js never loads below 768 px, and what stood in for it was a CSS
 * radial gradient — a 177 px soft green cloud with a visible dark ring where
 * one colour stop met the next. It was the only unfocused object on a page of
 * razor-sharp type, so it read as a broken asset rather than as a deliberate
 * trade.
 *
 * This is the same icosahedron, drawn instead of blurred: all 30 edges of a
 * real icosahedron, orthographically projected and tilted 18° / 12° so it
 * reads as a solid, stroked in cognition lime with a drop-shadow behind it.
 * The old gradient survives as the inner core at 40 % of the radius, which is
 * the part of it that was doing any work. Vector, so it is crisp at 3× DPR,
 * and about 700 bytes of markup instead of a 239 KB chunk.
 */
function OrbSilhouette() {
  return (
    <svg
      viewBox="0 0 100 100"
      width="100%"
      height="100%"
      aria-hidden
      focusable="false"
      style={{ display: "block", filter: "drop-shadow(0 0 18px rgb(184 255 90 / 0.35))" }}
    >
      <defs>
        <radialGradient id="viva-orb-core" cx="50%" cy="42%" r="50%">
          <stop offset="0%" stopColor="rgb(184 255 90 / 0.30)" />
          <stop offset="55%" stopColor="rgb(184 255 90 / 0.08)" />
          <stop offset="100%" stopColor="rgb(184 255 90 / 0)" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="20" fill="url(#viva-orb-core)" />
      <path
        d="M29.8 14.4L75 14.4M29.8 14.4L58.9 39.6M29.8 14.4L44.1 16.4M29.8 14.4L8.8 42.9M29.8 14.4L18 57.1M75 14.4L58.9 39.6M75 14.4L44.1 16.4M75 14.4L82 42.9M75 14.4L91.2 57.1M25 85.6L70.2 85.6M25 85.6L55.9 83.6M25 85.6L41.1 60.4M25 85.6L8.8 42.9M25 85.6L18 57.1M70.2 85.6L55.9 83.6M70.2 85.6L41.1 60.4M70.2 85.6L82 42.9M70.2 85.6L91.2 57.1M55.9 83.6L58.9 39.6M55.9 83.6L91.2 57.1M55.9 83.6L18 57.1M58.9 39.6L91.2 57.1M58.9 39.6L18 57.1M41.1 60.4L44.1 16.4M41.1 60.4L82 42.9M41.1 60.4L8.8 42.9M44.1 16.4L82 42.9M44.1 16.4L8.8 42.9M82 42.9L91.2 57.1M8.8 42.9L18 57.1"
        fill="none"
        stroke="var(--color-cognition)"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
    </svg>
  );
}
