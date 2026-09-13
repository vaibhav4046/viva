"use client";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
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
 *
 * The orb the host carries used to be a three.js canvas on desktops and a
 * drawn SVG everywhere else. It is now one object for everyone: a disc built
 * from two CSS gradients and two rasterised turbulence textures (see
 * orb.css). The reference this was rebuilt against is a flat disc with a
 * colour ramp and drifting cloud — a 2D problem — so three.js, its fiber
 * binding, the WebGL probe, the hardware-concurrency tier and the mobile
 * cutout all went with it, and the landing no longer downloads a 239 KB chunk
 * on any device. Reduced motion, phones, saveData and machines without WebGL
 * now get the same orb rather than a lesser one; the only thing reduced
 * motion changes is that the drift phase stops advancing.
 */

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

/* The host must be in the right place before the browser paints, but it must
 * not be running a loop while the page is still hydrating. useLayoutEffect
 * gives the first; the idle callback inside it gives the second. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Axis = { value: number; target: number; velocity: number };
const axis = (v = 0): Axis => ({ value: v, target: v, velocity: 0 });

/**
 * How the two cloud banks drift, in cycles per second and in percent of their
 * own (deliberately oversized) box.
 *
 * At rest the far bank takes about 22 s to come back to where it started —
 * slow enough to read as weather rather than as an animation, which is the
 * state a first-time visitor sees. A voice multiplies the rate rather than
 * adding to it, so a spoken phrase makes the cloud travel instead of making
 * the disc inflate; the disc's geometry never changes at all.
 *
 * The amplitudes are well inside the mist layer's overhang (55% horizontally,
 * 42% vertically in orb.css), so no drift can ever pull an edge into the disc.
 */
const DRIFT = {
  a: { rest: 0.045, voice: 0.28, amp: 9 },
  b: { rest: 0.031, voice: 0.21, amp: 7 },
} as const;

const TAU = Math.PI * 2;

/**
 * Mount once, in the root layout, as a sibling of `{children}` so it is
 * outside `template.tsx` and survives navigation.
 */
export function OrbHost() {
  const host = useRef<HTMLDivElement>(null);

  /* The follow loop: one rAF, one transform write, no React state. */
  useIsoLayoutEffect(() => {
    const el = host.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const x = axis();
    const y = axis();
    const scale = axis(1);
    const axes = [x, y, scale];
    let phaseA = 0;
    let phaseB = 0.37; // out of step with A from the first frame

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
      // Only what orb.css actually reads. `low` still drives the drift rate,
      // but it does that in here, not through a property nothing consumes.
      el.style.setProperty("--orb-level", orbBands.level.toFixed(3));
      el.style.setProperty("--orb-drift-a", (Math.sin(phaseA * TAU) * DRIFT.a.amp).toFixed(3));
      el.style.setProperty("--orb-drift-b", (Math.cos(phaseB * TAU) * DRIFT.b.amp).toFixed(3));
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

      // The cloud. Reduced motion leaves the phase where it is, so the mist is
      // a still photograph and `getAnimations()` stays 0 — there are no CSS
      // animations on the orb for it to have found anyway.
      if (!reduced.matches) {
        phaseA = (phaseA + dt * (DRIFT.a.rest + orbBands.low * DRIFT.a.voice)) % 1;
        phaseB = (phaseB + dt * (DRIFT.b.rest + orbBands.low * DRIFT.b.voice)) % 1;
      }

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
      <OrbDisc />
    </div>
  );
}

/**
 * The orb itself: a flat disc, everywhere, on every device.
 *
 * Three empty elements and a stylesheet. The colour field is two CSS
 * gradients; the cloud is two rasterised feTurbulence textures inside data
 * URIs, masked to the lower two thirds and translated by a custom property the
 * host writes each frame. It is resolution independent, it costs no JavaScript
 * of its own, and it scales and travels between slots exactly as the canvas
 * did — the host does that work, not the orb.
 *
 * The tuning lives in orb.css, next to the measurement it came from.
 */
function OrbDisc() {
  return (
    <div className="orb-disc">
      <span className="orb-mist orb-mist--far">
        <i />
      </span>
      <span className="orb-mist orb-mist--near">
        <i />
      </span>
    </div>
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
