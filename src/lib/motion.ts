/**
 * Motion tokens. One vocabulary for every animation in the app.
 *
 * Springs rather than durations for anything a person triggers: a spring
 * retargets mid-flight, so an interrupted interaction stays continuous instead
 * of snapping. Fixed durations are kept only for exits, which nobody waits on.
 *
 * Rules that go with these (see VIVA_MASTER_PROMPT.md §7.2):
 *  - animate `transform` and `opacity` only, so it stays on the compositor
 *  - never animate `box-shadow`; use `filter: drop-shadow(...)`
 *  - 30–50 ms stagger per item, one or two moving things per view
 *  - `useReducedMotion()` swaps movement for a plain opacity change
 */

/** Default for most UI: panels appearing, cards settling. */
export const SPRING = { type: "spring", visualDuration: 0.3, bounce: 0.2 } as const;

/** Buttons and anything under a finger — reacts immediately, settles fast. */
export const SNAPPY = { type: "spring", stiffness: 500, damping: 30, mass: 0.8 } as const;

/** Larger surfaces: sheets, the subject map, graph nodes. */
export const GENTLE = { type: "spring", stiffness: 120, damping: 20 } as const;

/** Exits run at roughly 65% of the enter so dismissal never feels sticky. */
export const EXIT = { duration: 0.18, ease: "easeIn" } as const;

/** Per-item delay for staggered lists. Cap the count so long lists stay snappy. */
export const STAGGER = 0.04;

/** Reduced-motion replacement: cross-fade only, no travel. */
export const FADE_ONLY = { duration: 0.15, ease: "easeOut" } as const;

/**
 * Standard enter/exit for a list item or panel.
 * Pass `reduced` from `useReducedMotion()` to drop the travel.
 */
export function rise(reduced: boolean) {
  return reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: FADE_ONLY }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 4 },
        transition: SPRING,
      };
}
