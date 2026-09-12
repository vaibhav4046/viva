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
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 50% 42%, rgb(184 255 90 / 0.28) 0%, rgb(184 255 90 / 0.07) 34%, rgb(14 16 19 / 0.9) 62%, transparent 72%)",
          }}
        />
      )}
    </div>
  );
}
