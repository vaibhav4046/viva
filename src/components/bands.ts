import { masteryState } from "@/lib/mastery";

/**
 * The five words a student ever sees for "how well do I know this".
 *
 * `masteryState` in src/lib/mastery.ts is the source of truth for the
 * thresholds; this maps its internal names onto plain English and a token.
 * Colour never travels alone — every place that uses a band colour also
 * prints the word.
 */
export type BandKey = "solid" | "getting" | "shaky" | "mixed" | "notyet";

export const BAND_LABEL: Record<BandKey, string> = {
  solid: "Solid",
  getting: "Getting there",
  shaky: "Shaky",
  mixed: "Mixed up",
  notyet: "Not yet",
};

export const BAND_COLOR: Record<BandKey, string> = {
  solid: "var(--color-band-solid)",
  getting: "var(--color-band-getting)",
  shaky: "var(--color-band-shaky)",
  mixed: "var(--color-band-mixed)",
  notyet: "var(--color-band-notyet)",
};

export const BAND_ORDER: BandKey[] = ["solid", "getting", "shaky", "mixed", "notyet"];

/** Band for a concept, given its mastery number and whether it has been seen. */
export function bandFor(mastery: number | undefined, seen = true): BandKey {
  if (mastery === undefined || !seen) return "notyet";
  switch (masteryState(mastery)) {
    case "strong":
      return "solid";
    case "developing":
      return "getting";
    case "uncertain":
      return "shaky";
    case "misconception":
      return "mixed";
    default:
      return "notyet";
  }
}
