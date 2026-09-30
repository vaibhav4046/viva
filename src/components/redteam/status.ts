import type { ChallengeKind, ClaimStatus } from "@/lib/redteam/types";
import type { VoiceState } from "@/lib/redteam/machine";

/** Display facts for each verdict. Colour never travels without its word and its shape. */
export const STATUS_ORDER: ClaimStatus[] = ["SUPPORTED", "PARTIAL", "CONTRADICTED", "UNSUPPORTED", "UNRESOLVED"];

export const STATUS_META: Record<ClaimStatus, { label: string; blurb: string; shape: "solid" | "half" | "cross" | "dashed" | "ring" }> = {
  SUPPORTED: { label: "Supported", blurb: "The document says this.", shape: "solid" },
  PARTIAL: { label: "Partial", blurb: "Part of it is backed.", shape: "half" },
  CONTRADICTED: { label: "Contradicted", blurb: "The document says otherwise.", shape: "cross" },
  UNSUPPORTED: { label: "Unsupported", blurb: "Not found in the document.", shape: "dashed" },
  UNRESOLVED: { label: "Unresolved", blurb: "Not enough to conclude.", shape: "ring" },
};

export const KIND_LABEL: Record<ChallengeKind, string> = {
  VERIFY: "Verify",
  CONTRADICT: "Contradiction",
  CLARIFY: "Clarify",
  STRESS_TEST: "Stress test",
  EDGE_CASE: "Edge case",
  CONNECT: "Connect",
  ADVANCE: "Wrap up",
};

/**
 * What the screen says about the session. A pure function of the machine's
 * state (and of whether a correction is pending), so no label can be showing
 * for a state the protocol is not actually in.
 */
export function stateLine(state: VoiceState | "TYPED", opts: { awaitingCorrection: boolean; reason?: string | null }): { label: string; detail: string } {
  switch (state) {
    case "IDLE":
      return { label: "Not started", detail: "Start the voice review, or type instead." };
    case "CONNECTING":
      return { label: "Connecting", detail: "Opening a Voice Agent session." };
    case "READY":
      return { label: "Ready", detail: "The session is up." };
    case "LISTENING":
      return { label: "Listening", detail: "Speak when you are ready." };
    case "USER_SPEAKING":
      return { label: "You are speaking", detail: "Live transcript below." };
    case "THINKING":
      return { label: "VIVA is composing a reply", detail: "Waiting on the Voice Agent." };
    case "CHECKING_SOURCE":
      return { label: "Checking the document", detail: "Looking for the passage that decides this." };
    case "SPEAKING":
      return { label: "VIVA is speaking", detail: "Talk over it to interrupt." };
    case "INTERRUPTED":
      return opts.awaitingCorrection
        ? { label: "Cut off", detail: "VIVA stopped. Say your correction." }
        : { label: "Cut off", detail: "VIVA stopped." };
    case "RECOVERING":
      return { label: "Reconnecting", detail: "The connection dropped. Resuming the same session." };
    case "ERROR":
      return { label: "Voice unavailable", detail: opts.reason ? opts.reason : "Type instead — the review keeps going." };
    case "ENDED":
      return { label: "Session ended", detail: "The report is below." };
    case "TYPED":
      return { label: "Typed review", detail: "Typed answers, same checks. Not the Voice Agent." };
  }
}
