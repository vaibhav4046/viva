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
      } else {
        m = { ...m, mastery: m.mastery - 0.02 };
        reason = "unverified claim stored";
      }
      break;
    case "explain":
    case "question":
      m = { ...m, mastery: m.mastery - 0.02 };
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
