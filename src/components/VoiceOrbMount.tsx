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
    // A phone does not need 20k triangles to read as a sphere.
    setDetail(window.matchMedia("(max-width: 767px)").matches ? 3 : 5);
    // Let the page settle before pulling in three.
    const id = window.setTimeout(() => setShow(true), 250);
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
