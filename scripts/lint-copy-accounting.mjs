/*
 * Internal accounting readouts that must never reach a student.
 *
 * These are patterns, not words, on purpose. A first pass banned the bare
 * words "chunks" and "evidence" and immediately flagged seventeen places —
 * including the Probability course's own prose ("given the evidence, how
 * should I update your belief?") and identifiers like SOURCE_CHUNKS.length.
 * A lint that cries wolf gets switched off, so each rule below matches the
 * shape of the leak rather than a word that also appears in honest writing.
 *
 * Kept in its own module because regex-heavy source does not survive being
 * edited through a shell.
 */
export const ACCOUNTING = [
  [
    /\bevidence\s+\$?\{?[^}]*\}?\s*chunks?\b/i,
    'internal readout — say "checked against N passages"',
  ],
  [/·\s*evidence\b/i, "internal readout — say what it was checked against"],
  [/\bmastery\s*[+-]\s*\$?\{?\d/i, "signed point delta — show the band, not the arithmetic"],
  [/\bmoved\s+(?:up|down)\s*[+-]?\s*\$?\{?\d/i, "signed point delta — show the band, not the arithmetic"],
  // Negative lookahead so Tailwind spacing classes are not points: "gap-2 pt-1"
  // and "pt-3" both end in a hyphen, "mastery -12 pts" does not.
  [/\b\d+\s*pts?(?![-\w])/i, "points are internal accounting — show the band"],
];
