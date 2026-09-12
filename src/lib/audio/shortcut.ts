/**
 * Who owns the Space key.
 *
 * Hold-Space-to-talk is a page-level shortcut, and the mic used to claim it by
 * calling preventDefault() on every keydown whose target was not a text field.
 * Space is also the native activation key for a button and the native scroll
 * key for the page, so on /study and /exam that meant every focusable control
 * started the microphone instead of doing its job: focusing "Skip to content"
 * — the first stop for a keyboard-only student — switched the mic on, and the
 * page could not be scrolled with the keyboard at all. Automated accessibility
 * checks cannot see a hijacked key, so nothing caught it.
 *
 * The rule is the inverse of what it was: the shortcut belongs to the page, and
 * anything focusable keeps its own Space.
 */

/** The slice of an element this needs — keeps the check unit-testable. */
export type SpaceTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => unknown;
};

/** Every element that has its own meaning for Space, or can be focused at all. */
const INTERACTIVE = 'button, a, select, textarea, input, summary, [role="button"], [tabindex]';

/**
 * True when the focused element owns Space and the mic must keep its hands off.
 * `body` is the page itself, which is where the shortcut lives.
 */
export function ownsSpace(target: unknown, body: unknown): boolean {
  if (!target || target === body) return false;
  const el = target as SpaceTarget;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return true;
  if (el.isContentEditable === true) return true;
  // Covers the wrappers: a span inside a button, an icon inside a link.
  return Boolean(el.closest?.(INTERACTIVE));
}
