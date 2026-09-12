/**
 * External-dictation detection for the typed box.
 *
 * Wispr Flow, OpenWhispr and the OS dictation services do not talk to VIVA;
 * they paste a finished sentence into whatever field has focus. A human typing
 * produces a character or two per input event, so more than a line of text
 * arriving inside a third of a second was spoken, not typed — and the turn
 * should be tagged that way so a learner with their own dictation tool still
 * gets the full loop.
 *
 * A paste is indistinguishable from a dictation drop at this level and is
 * treated the same, which is the honest reading: neither of them was typed.
 */

/** Characters inside the window above which the text was not typed. */
export const BURST_CHARS = 40;
/** Rolling window the characters must land in. */
export const BURST_WINDOW_MS = 300;

export type TextOrigin = "typed" | "external-dictation";

/** Rolling burst window. Start one per field with `emptyBurst()`. */
export type BurstState = {
  windowStart: number;
  charsInWindow: number;
  origin: TextOrigin;
};

export function emptyBurst(): BurstState {
  return { windowStart: 0, charsInWindow: 0, origin: "typed" };
}

/**
 * Fold one input event into the window. Immutable: returns the next state.
 *
 * Once a field has taken a burst the origin stays external — later
 * single-character corrections do not turn a dictated sentence back into a
 * typed one, because the body of the text still came from a dictation tool.
 *
 * @param added characters this event added (`next.length - previous.length`)
 * @param now   event timestamp in ms
 */
export function foldBurst(state: BurstState, added: number, now: number): BurstState {
  if (added <= 0) return state;
  const fresh = now - state.windowStart > BURST_WINDOW_MS;
  const charsInWindow = (fresh ? 0 : state.charsInWindow) + added;
  return {
    windowStart: fresh ? now : state.windowStart,
    charsInWindow,
    origin: state.origin === "external-dictation" || charsInWindow > BURST_CHARS ? "external-dictation" : "typed",
  };
}
