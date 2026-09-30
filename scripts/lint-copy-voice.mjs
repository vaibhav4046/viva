/*
 * Voice rules for shipped copy (design directive section 8.1).
 *
 * Kept in its own module so scripts/lint-copy.mjs keeps its own rule sets and
 * scripts/audit-vibe.mjs can apply the same list to README and docs. This file
 * is ASCII on purpose: the dash rules are written as escapes, so the file that
 * bans the characters does not contain them.
 *
 * Each entry: [pattern, reason]. Patterns are case-insensitive.
 */
const AMP = String.fromCharCode(38);
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const CURLY = String.fromCharCode(0x2019);

export const VOICE = [
  [new RegExp(`${EM}|${EN}|${AMP}(mdash|ndash|#8212|#8211);`), "em or en dash: use a comma, colon, period or parentheses"],
  [/\w!(?=\s|$)/, "exclamation mark in product copy"],
  [/\bsupercharge/i, "banned word"],
  [/unlock the power/i, "banned phrase"],
  [/\brevolutioni[sz]e|\brevolutionary\b/i, "banned word"],
  [/\bseamless(ly)?\b/i, "banned word"],
  [/next-gen(eration)?\b/i, "banned word"],
  [/cutting-edge/i, "banned word"],
  [/game-?changer/i, "banned word"],
  [/\bAI-powered\b|\bpowered by AI\b/i, "banned phrase: say what it does"],
  [/intelligent copilot|your AI cofounder/i, "banned phrase"],
  [/built for the future|take it to the next level/i, "banned phrase"],
  [/\bharness(es|ed|ing)?\b/i, "banned word"],
  [/\bleverag(e|es|ed|ing)\b/i, "banned word (verb)"],
  [/\bdelv(e|es|ed|ing)\b/i, "banned word"],
  [/\belevate(s)?\b|\belevating\b/i, "banned word"],
  [/\bempower(s|ed|ing|ment)?\b/i, "banned word"],
  [/\btapestry\b/i, "banned word"],
  [/in today'?s fast-paced world/i, "banned phrase"],
  [/lightning[- ]fast|\bblazing\b/i, "banned phrase"],
  [/enterprise-grade|military-grade/i, "banned phrase"],
  [new RegExp(`\\b(is not|isn't|isn${CURLY}t)\\b[^.\\n]{3,60}[,;.]\\s*(it's|it is|it${CURLY}s)\\b`, "i"), "'not X, it is Y' construction"],
];

export function voiceHits(text) {
  const out = [];
  for (const [re, why] of VOICE) {
    const m = re.exec(text);
    if (m) out.push({ phrase: m[0], why, index: m.index });
  }
  return out;
}
