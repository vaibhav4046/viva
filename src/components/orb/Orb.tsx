"use client";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GENTLE } from "@/lib/motion";
import { advanceBands, orbBands } from "./orbState";
import "./orb.css";

/**
 * One orb, moved — not two orbs, cross-faded.
 *
 * `OrbHost` mounts the orb exactly once, in the root layout, outside
 * `src/app/template.tsx`. Pages do not render the orb; they render an
 * `OrbSlot`, an empty reserved box that says "the orb belongs here, this
 * big". The host measures whichever slot is currently on screen and springs
 * its own transform onto it. Navigate, and the slot changes: the same canvas,
 * the same WebGL context, the same shader state travels from the middle of
 * the landing hero down into the study screen's mic row.
 *
 * Why not Motion's `layoutId`, which is the usual answer for a shared element:
 *
 *  1. `src/app/template.tsx` wraps every route in `AnimatePresence mode="wait"`.
 *     A `layoutId` handover needs both elements alive in the same commit — the
 *     outgoing one supplies the box the incoming one animates from. `mode="wait"`
 *     unmounts the old tree first, on purpose, so the pair never coexists.
 *  2. A template re-mounts on every navigation, so the `LazyMotion` tree that
 *     would be holding that projection state is itself torn down mid-move.
 *  3. `/` and `/study` also live in different layout subtrees (root vs the
 *     `(app)` group), so the two elements are never siblings under one
 *     `LayoutGroup`.
 *  4. Even with all three fixed, `layoutId` means two React elements: the
 *     outgoing `<Canvas>` unmounts, which destroys the WebGL context, and the
 *     incoming one compiles the shaders again in the middle of the transition.
 *     That is the opposite of one continuous object.
 *
 * So the host does the FLIP by hand against a live measurement, with the
 * spring constants taken from `GENTLE` in src/lib/motion.ts so it belongs to
 * the same motion vocabulary as everything else. Transform and opacity only.
 * It is fully interruptible — the spring retargets mid-flight — and because
 * the orb keeps its last target while the route gap is open, it is visible
 * and moving during the whole `mode="wait"` handover rather than blinking.
 */

const VoiceOrb = dynamic(() => import("@/components/three/VoiceOrb"), {
  ssr: false,
  loading: () => null,
});

/** The host's intrinsic box. Slots are matched to it by scaling this. */
const ORB_BASE_PX = 240;

/* ------------------------------------------------------------------ slots */

type Slot = { el: HTMLElement; priority: number; seq: number };

const slots = new Set<Slot>();
let slotSeq = 0;

/** Highest priority wins; newest breaks the tie. */
function activeSlot(): HTMLElement | null {
  let best: Slot | null = null;
  for (const slot of slots) {
    if (!slot.el.isConnected) continue;
    if (!best || slot.priority > best.priority || (slot.priority === best.priority && slot.seq > best.seq)) {
      best = slot;
    }
  }
  return best?.el ?? null;
}

/**
 * Reserve the orb's place on a page. Renders an empty box of your size — give
 * it a class, or let `.orb-slot` size it — and the orb flies to it.
 *
 * @param priority Higher wins when two slots are mounted at once, which
 *                 happens for a moment during a route change.
 */
export function OrbSlot({
  className = "orb-slot",
  style,
  priority = 0,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  priority?: number;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const slot: Slot = { el, priority, seq: ++slotSeq };
    slots.add(slot);
    return () => {
      slots.delete(slot);
    };
  }, [priority]);

  return (
    <div ref={ref} className={className} style={style} aria-hidden={children ? undefined : true}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- host */

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Whether this machine gets the canvas at all.
 *
 * Measured on the deployed landing before this guard existed: mobile
 * Lighthouse Performance 66, 1,110 ms total blocking time, 2.0 s of script
 * bootup, with a single 239 KB chunk — three.js — dominating a 430 KB payload.
 * Delaying the import does not help; the download and parse still land inside
 * the window the score measures. So phones get the drawn fallback, which is
 * about 700 bytes of SVG and travels between slots exactly the same way.
 */
function canRunCanvas(): { run: boolean; detail: number } {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return { run: false, detail: 4 };
  if (!hasWebGL()) return { run: false, detail: 4 };
  if (window.matchMedia("(max-width: 767px)").matches) return { run: false, detail: 4 };

  type NetworkInfo = { saveData?: boolean; effectiveType?: string };
  const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  if (conn?.saveData) return { run: false, detail: 4 };
  if (conn?.effectiveType && /(^|-)(2g|3g)$/.test(conn.effectiveType)) return { run: false, detail: 4 };

  // Four cores or fewer is a netbook or a cheap laptop; give it half the
  // vertices rather than none of the orb.
  const detail = (navigator.hardwareConcurrency ?? 8) <= 4 ? 4 : 5;
  return { run: true, detail };
}

/* The host must be in the right place before the browser paints, but it must
 * not be running a loop while the page is still hydrating. useLayoutEffect
 * gives the first; the idle callback inside it gives the second. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Axis = { value: number; target: number; velocity: number };
const axis = (v = 0): Axis => ({ value: v, target: v, velocity: 0 });

/**
 * Mount once, in the root layout, as a sibling of `{children}` so it is
 * outside `template.tsx` and survives navigation.
 */
export function OrbHost() {
  const host = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<{ run: boolean; detail: number }>({ run: false, detail: 5 });
  const [paused, setPaused] = useState(false);

  /* Decide on the canvas once the main thread is genuinely idle, so the
   * import can never compete with hydration or LCP. */
  useEffect(() => {
    const decision = canRunCanvas();
    if (!decision.run) return;
    const start = () => setCanvas(decision);
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === "function") {
      const handle = ric(start, { timeout: 3000 });
      return () => {
        (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
      };
    }
    const id = window.setTimeout(start, 1200);
    return () => window.clearTimeout(id);
  }, []);

  /* Stop the render loop when the orb is off screen. `frameloop="never"` is
   * free; an early return inside useFrame still clears and redraws. */
  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting), { rootMargin: "80px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* The follow loop: one rAF, one transform write, no React state. */
  useIsoLayoutEffect(() => {
    const el = host.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const x = axis();
    const y = axis();
    const scale = axis(1);
    const axes = [x, y, scale];

    let placed = false;
    let lastFrame = performance.now();
    let lastMeasure = 0;
    let frame = 0;

    const measure = () => {
      const slot = activeSlot();
      // No slot on this route: hold the last target. During the route gap
      // opened by AnimatePresence mode="wait" this is what keeps the orb on
      // screen and moving instead of blinking out and back.
      if (!slot) return false;
      const r = slot.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return true;
      x.target = r.left + window.scrollX + r.width / 2 - ORB_BASE_PX / 2;
      y.target = r.top + window.scrollY + r.height / 2 - ORB_BASE_PX / 2;
      scale.target = Math.max(r.width, r.height) / ORB_BASE_PX;
      return true;
    };

    /* GENTLE is { stiffness: 120, damping: 20 } at mass 1. Integrated in fixed
     * 1/120 s substeps: a single 50 ms step at k=120 rings badly, and a tab
     * returning from the background hands back exactly that. */
    const K = GENTLE.stiffness;
    const C = GENTLE.damping;
    const STEP = 1 / 120;

    const settle = (dt: number) => {
      let remaining = Math.min(dt, 0.25);
      while (remaining > 0) {
        const h = Math.min(STEP, remaining);
        remaining -= h;
        for (const a of axes) {
          a.velocity += (K * (a.target - a.value) - C * a.velocity) * h;
          a.value += a.velocity * h;
        }
      }
    };

    const snap = () => {
      for (const a of axes) {
        a.value = a.target;
        a.velocity = 0;
      }
    };

    const paint = () => {
      el.style.transform = `translate3d(${x.value.toFixed(2)}px, ${y.value.toFixed(2)}px, 0) scale(${scale.value.toFixed(4)})`;
      el.style.opacity = activeSlot() ? "1" : "0";
      el.style.setProperty("--orb-level", orbBands.level.toFixed(3));
      el.style.setProperty("--orb-low", orbBands.low.toFixed(3));
    };

    /* Place it before the first paint: one rect read and one transform write,
     * so the orb is never briefly parked at the top-left of the document.
     *
     * Slots register in a passive effect, which runs after this layout effect,
     * so on the very first pass there is usually nothing to measure yet — hence
     * the single deferred frame below. Between them the orb is on screen in the
     * frame after hydration, without a loop running through it. */
    placed = measure();
    snap();
    paint();
    const firstFrame = requestAnimationFrame(() => {
      if (placed) return;
      placed = measure();
      snap();
      paint();
    });

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min((now - lastFrame) / 1000, 0.25);
      lastFrame = now;

      advanceBands(dt);

      // Re-measuring forces layout, so only do it every frame while the orb
      // is actually travelling. At rest, ten times a second is plenty to
      // catch a reflow above the slot.
      // ponytail: polling beats a MutationObserver here; swap if a page ever
      // moves the slot without resizing the body.
      const moving =
        Math.abs(x.target - x.value) > 0.4 ||
        Math.abs(y.target - y.value) > 0.4 ||
        Math.abs(scale.target - scale.value) > 0.002;
      let live = true;
      // Do NOT measure while moving. The spring animates this host's own
      // transform; the slot it is flying toward does not move, so re-reading
      // its rect every frame buys nothing and costs a forced synchronous
      // layout. On the landing-to-study commit that single
      // getBoundingClientRect was measured at 169 ms, which is the whole of
      // the hitch on that navigation. The 10 Hz poll below still catches a
      // slot that reflows underneath us.
      if (now - lastMeasure > 100) {
        live = measure();
        lastMeasure = now;
      }

      if (!placed) {
        snap();
        placed = live;
      } else if (reduced.matches) {
        snap();
      } else {
        settle(dt);
      }

      paint();
    };

    /* Sixty transform writes a second are cheap, but not while the browser is
     * still hydrating the page: starting this immediately cost ~0.3 s of
     * script bootup and 0.2 s of LCP on the mobile Lighthouse run. The orb is
     * already in place by then, so waiting for idle costs nothing visible.
     */
    let idle: number | undefined;
    let timer: number | undefined;
    const startLoop = () => {
      lastFrame = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === "function") idle = ric(startLoop, { timeout: 2000 });
    else timer = window.setTimeout(startLoop, 400);

    const remeasure = () => {
      lastMeasure = 0;
    };
    window.addEventListener("resize", remeasure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
    ro?.observe(document.body);

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(firstFrame);
      if (idle !== undefined) {
        (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(idle);
      }
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("resize", remeasure);
      ro?.disconnect();
    };
  }, []);

  return (
    <div ref={host} className="orb-host" aria-hidden>
      <span className="orb-halo" />
      {canvas.run ? <VoiceOrb detail={canvas.detail} paused={paused} /> : <OrbSilhouette />}
    </div>
  );
}

/**
 * The orb without WebGL: phones, reduced motion, and anything that cannot
 * answer for a GL context.
 *
 * All 30 edges of a real icosahedron, orthographically projected and tilted
 * 18° / 12° so it reads as a solid, stroked in cognition lime over a soft
 * core. Vector, so it is crisp at 3× DPR, and about 700 bytes of markup
 * instead of a 239 KB chunk. It scales and travels between slots exactly like
 * the canvas does, so the shared-element move is not a desktop-only feature,
 * and `--orb-level` makes it breathe with the voice from CSS alone.
 */
function OrbSilhouette() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false" className="orb-svg">
      <defs>
        <radialGradient id="viva-orb-core" cx="50%" cy="42%" r="50%">
          <stop offset="0%" stopColor="rgb(184 255 90 / 0.32)" />
          <stop offset="55%" stopColor="rgb(184 255 90 / 0.09)" />
          <stop offset="100%" stopColor="rgb(184 255 90 / 0)" />
        </radialGradient>
      </defs>
      <circle className="orb-svg__core" cx="50" cy="50" r="20" fill="url(#viva-orb-core)" />
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

/* --------------------------------------------------------------- backdrop */

/**
 * The app's ground. Same family as the orb — lime light pooling in obsidian,
 * over the dot lattice the landing headline is cut from — and it costs no
 * JavaScript at all: two blobs drifting on `transform`, one static lattice,
 * one vignette. Nothing here is measured, subscribed to, or re-rendered.
 *
 * Wrap the app's content in it so the content lands on the layer above:
 * `<OrbBackdrop>{children}</OrbBackdrop>`.
 */
export function OrbBackdrop({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="orb-backdrop" aria-hidden>
        <span className="orb-backdrop__lattice" />
        <span className="orb-backdrop__pool orb-backdrop__pool--a" />
        <span className="orb-backdrop__pool orb-backdrop__pool--b" />
        <span className="orb-backdrop__vignette" />
      </div>
      {children ? <div className="orb-above">{children}</div> : null}
    </>
  );
}

export { setOrbLevel, setOrbAnalyser } from "./orbState";
