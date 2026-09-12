import type { ConceptMastery, LearningEvent } from "./types";

export function blankMastery(conceptId: string, now: string): ConceptMastery {
  return {
    conceptId,
    exposureCount: 0,
    successfulRecallCount: 0,
    failedRecallCount: 0,
    confusionCount: 0,
    misconceptionCount: 0,
    teachbackScoreAvg: null,
    lastSeenAt: now,
    lastSuccessfulRecallAt: null,
    mastery: 0.5,
    confidence: 0.3,
    reviewPriority: 0.5,
  };
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, Math.round(x * 100) / 100));
}

/**
 * HARNESS C — Learner Model Reducer. Deterministic, bounded, reviewable.
 * No LLM writes mastery directly; events are the source of truth and this
 * function is a pure fold over them. Displayed as "VIVA estimate" with reasons.
 */
export function reduceMastery(
  prev: ConceptMastery,
  event: Pick<LearningEvent, "intent" | "createdAt"> & {
    assessment?: "correct" | "partial" | "incorrect" | null;
    teachbackScore?: number | null;
    /** Direction only, from the tutor. The number is computed here. */
    masterySignal?: "up" | "down" | "flat" | null;
  }
): { next: ConceptMastery; delta: number; reason: string } {
  const now = event.createdAt;
  let m = { ...prev, exposureCount: prev.exposureCount + 1, lastSeenAt: now };
  let reason = "seen in session";

  switch (event.intent) {
    case "confusion":
      m = { ...m, confusionCount: m.confusionCount + 1, mastery: m.mastery - 0.08 };
      reason = "new unresolved confusion";
      break;
    case "remember":
    case "exam_marker":
      m = { ...m, mastery: m.mastery + 0.02 };
      reason = "marked important — exposure";
      break;
    case "quiz_request":
    case "review_request":
      m = { ...m, mastery: m.mastery + 0.01 };
      reason = "requested recall";
      break;
    case "claim":
    case "teachback":
      if (event.assessment === "correct") {
        const gain = event.intent === "teachback" ? 0.12 : 0.06;
        m = {
          ...m,
          successfulRecallCount: m.successfulRecallCount + 1,
          lastSuccessfulRecallAt: now,
          mastery: m.mastery + gain,
          teachbackScoreAvg:
            event.teachbackScore != null
              ? (m.teachbackScoreAvg ?? event.teachbackScore) * 0.5 + event.teachbackScore * 0.5
              : m.teachbackScoreAvg,
        };
        reason = event.intent === "teachback" ? "correct teachback" : "correct recall";
      } else if (event.assessment === "partial") {
        m = { ...m, successfulRecallCount: m.successfulRecallCount, mastery: m.mastery + 0.02 };
        reason = "partially correct — one piece missing";
      } else if (event.assessment === "incorrect") {
        m = {
          ...m,
          failedRecallCount: m.failedRecallCount + 1,
          misconceptionCount: m.misconceptionCount + 1,
          mastery: m.mastery - 0.12,
        };
        reason = "unsupported claim — possible misconception";
      } else if (event.masterySignal === "up") {
        m = { ...m, mastery: m.mastery + 0.04 };
        reason = "said it right, not yet checked out loud";
      } else if (event.masterySignal === "down") {
        m = { ...m, mastery: m.mastery - 0.06 };
        reason = "that part did not match your source";
      } else {
        m = { ...m, mastery: m.mastery - 0.02 };
        reason = "unverified claim stored";
      }
      break;
    case "explain":
    case "question":
      m = { ...m, mastery: m.mastery + (event.masterySignal === "up" ? 0.01 : -0.02) };
      reason = "open question — awaiting evidence";
      break;
    default:
      reason = "noted";
  }

  m.mastery = clamp01(m.mastery);
  // Review priority: high when mastery low + recent confusion/misconception.
  m.reviewPriority = clamp01(
    0.3 * (1 - m.mastery) + 0.3 * Math.min(1, m.confusionCount / 3) +
      0.3 * Math.min(1, m.misconceptionCount / 2) + 0.1 * Math.min(1, m.failedRecallCount / 3) + 0.2 * (1 - m.mastery)
  );
  m.confidence = clamp01(Math.min(0.95, 0.3 + m.exposureCount * 0.08));
  const delta = Math.round((m.mastery - prev.mastery) * 100) / 100;
  return { next: m, delta, reason };
}

export function masteryState(mastery: number): "strong" | "developing" | "uncertain" | "misconception" | "unseen" {
  if (mastery >= 0.75) return "strong";
  if (mastery >= 0.55) return "developing";
  if (mastery >= 0.35) return "uncertain";
  return "misconception";
}

/** The five words a student ever sees for "how well do I know this". */
export type BandKey = "solid" | "getting" | "shaky" | "mixed" | "notyet";

export const BAND_LABEL: Record<BandKey, string> = {
  solid: "Solid",
  getting: "Getting there",
  shaky: "Shaky",
  mixed: "Mixed up",
  notyet: "Not yet",
};

/**
 * The band a concept sits in, from its stored record. A concept nobody has
 * touched is "Not yet" whether or not a row exists for it — a row written at
 * the default 0.5 is an absence of information, not a measurement of one.
 *
 * This is the unit the API returns. The signed point delta stays inside the
 * reducer: numbers move the model, words move the student.
 */
export function bandKeyFor(state: { mastery: number; exposureCount?: number } | null | undefined): BandKey {
  if (!state || (state.exposureCount ?? 1) === 0) return "notyet";
  switch (masteryState(state.mastery)) {
    case "strong": return "solid";
    case "developing": return "getting";
    case "uncertain": return "shaky";
    case "misconception": return "mixed";
    default: return "notyet";
  }
}

export function bandLabelFor(state: { mastery: number; exposureCount?: number } | null | undefined): string {
  return BAND_LABEL[bandKeyFor(state)];
}
