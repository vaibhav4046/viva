import { bandLabelFor } from "@/lib/mastery";
import type { ConceptMastery } from "@/lib/types";
import { chooseNext, rankWeakest, type ConceptRef } from "./next-concept";

/**
 * What the stored learner map says about this student on this subject, in the
 * form the examiner prompt and the screen both read.
 *
 * "Stored" means the map already held evidence before this exam started: a
 * concept of this subject with at least one recorded exposure. Nothing is
 * inferred. When there is none the brief says so, and when the store is the
 * temporary file store it says that too, so the examiner is never told it
 * remembers something it may lose.
 */

export const BRIEF_MAX_CONCEPTS = 5;

export type BriefConcept = {
  conceptId: string;
  name: string;
  /** The map's own word: Solid, Getting there, Shaky, Mixed up. */
  band: string;
  missed: number;
  misconceptions: number;
};

export type LearnerBrief = {
  status: "stored" | "empty";
  /** False when the store is the temporary file store, so history can vanish on restart. */
  durable: boolean;
  /** Touched concepts of this subject, weakest first, at most BRIEF_MAX_CONCEPTS. */
  concepts: BriefConcept[];
  /** Where the exam opens: the weakest concept by the same ranking the chooser uses. */
  opening: { conceptId: string; name: string; examinedBefore: boolean } | null;
  /** One sentence for the screen. */
  note: string;
};

export const EPHEMERAL_HISTORY_NOTE = "This history sits on temporary demo storage and is lost when the server restarts.";

export function buildLearnerBrief(input: {
  concepts: ConceptRef[];
  mastery: Record<string, ConceptMastery>;
  durable: boolean;
}): LearnerBrief {
  const { concepts, mastery, durable } = input;
  const touched = concepts.filter((c) => (mastery[c.id]?.exposureCount ?? 0) > 0);
  const ranked = rankWeakest(touched, mastery).slice(0, BRIEF_MAX_CONCEPTS);
  const opening = chooseNext({ concepts, mastery, turns: [] });

  if (touched.length === 0) {
    return {
      status: "empty",
      durable,
      concepts: [],
      opening: null,
      note: durable
        ? "No earlier answers are stored for this subject, so the exam starts from the first concept."
        : "No earlier answers are stored for this subject, and this demo server does not keep history across restarts.",
    };
  }

  return {
    status: "stored",
    durable,
    concepts: ranked.map((c) => ({
      conceptId: c.id,
      name: c.name,
      band: bandLabelFor(mastery[c.id]),
      missed: mastery[c.id].failedRecallCount,
      misconceptions: mastery[c.id].misconceptionCount,
    })),
    opening: opening
      ? { conceptId: opening.conceptId, name: opening.conceptName, examinedBefore: touched.some((c) => c.id === opening.conceptId) }
      : null,
    note: durable
      ? "Read from your stored map before the exam started."
      : `Read from your stored map before the exam started. ${EPHEMERAL_HISTORY_NOTE}`,
  };
}

/** The lines of the examiner prompt that carry the brief. */
export function briefPromptLines(brief: LearnerBrief): string[] {
  const lost = brief.durable ? [] : [EPHEMERAL_HISTORY_NOTE + " Do not promise the student that this will be remembered next time."];
  if (brief.status === "empty") {
    return [
      "STORED HISTORY: none for this student on this subject.",
      "Do not say or imply that you remember them or any earlier session.",
      ...lost,
      "",
      "Open the exam by asking for the first thing they want to be examined on.",
    ];
  }
  return [
    "STORED HISTORY, read from the student's map before this exam, weakest first:",
    ...brief.concepts.map((c) => {
      const facts = [c.band, c.missed > 0 ? `missed ${c.missed} time${c.missed === 1 ? "" : "s"}` : "", c.misconceptions > 0 ? `${c.misconceptions} misconception${c.misconceptions === 1 ? "" : "s"} recorded` : ""].filter(Boolean);
      return `- ${c.name}: ${facts.join(", ")}`;
    }),
    "State only what is listed here about earlier sessions. Do not invent details of them.",
    ...lost,
    "",
    !brief.opening
      ? "Open the exam by asking for the first thing they want to be examined on."
      : brief.opening.examinedBefore
        ? `Open the exam with one recall question on ${brief.opening.name}. Say in one short sentence that you start there because their record shows it weakest.`
        : `Open the exam with one recall question on ${brief.opening.name}, which their record does not cover yet. Say that in one short sentence.`,
  ];
}
