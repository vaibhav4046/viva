/**
 * Code-side checks on a verdict a model proposed for a learner's claim.
 *
 * The model says supported, contradicted or not_in_material and names a quote.
 * Substring presence proves the quote exists, and nothing more: cutting
 * "converge to a global minimum" out of "does not always converge to a global
 * minimum" is a verbatim quote that says the opposite. These checks are
 * deliberately conservative. Each one can only turn a confirmation or a
 * correction into "the material does not settle it", never the reverse, so a
 * miss costs a missed correction and never a false one.
 *
 * Limits, stated: negation is detected by word list, so "unlike", "rather
 * than" and scope tricks are not seen; content overlap is lexical; none of this
 * understands meaning. It shrinks the set of confident wrong verdicts. It does
 * not remove it.
 */

/** A gap this long between two elided pieces is too much source to skip silently. */
export const MAX_ELISION_GAP = 160;
/** Content words the claim and the quote must share, and the share of the claim's own. */
export const MIN_SHARED_STEMS = 2;
export const MIN_SHARED_FRACTION = 0.2;

const NEGATION =
  /\b(?:not|no|never|cannot|none|neither|nor|nothing|nobody|nowhere|without|unable|fails?\s+to|failed\s+to)\b|n['’]t\b/i;

export const hasNegation = (text: string): boolean => NEGATION.test(text);

const STOP = new Set(
  "that this with from have been were them then than they their there which what when where will would could should about into over also each more most some such only both does just like very much many any all can its the and for are but not you your our out has had was who how why".split(" ")
);

/** Crude on purpose: the first five letters, so "independent" and "independence" meet. */
const stem = (word: string): string => word.toLowerCase().slice(0, 5);

/** Stems of the words worth comparing: 4+ letters, not a function word or a negation. */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[A-Za-z]{4,}/g) ?? []) {
    if (!STOP.has(w.toLowerCase()) && !NEGATION.test(w)) out.add(stem(w));
  }
  return out;
}

const shared = (a: Set<string>, b: Set<string>): number => [...a].filter((s) => b.has(s)).length;

/** Enough of the claim's own subject matter appears in the quote for the quote to be about the claim. */
export function overlapsClaim(claim: string, quote: string): boolean {
  const c = contentStems(claim);
  if (c.size === 0) return false;
  const n = shared(c, contentStems(quote));
  return n >= MIN_SHARED_STEMS && n / c.size >= MIN_SHARED_FRACTION;
}

/**
 * Sentence and clause units of a passage, as [start, end) offsets into `text`.
 * A boundary is . ! ? before a capital, digit or quote, or a ; or : before a space.
 */
export function units(text: string): [number, number][] {
  const out: [number, number][] = [];
  const boundary = /[.!?]["')\]]*\s+(?=["'(\[]?[A-Z0-9])|[;:]\s+/g;
  let start = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const end = m.index + m[0].trimEnd().length;
    if (end > start) out.push([start, end]);
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * The passage range a quote piece occupies, widened to whole units, or null
 * when the piece starts or ends inside a word. Widening is what puts a
 * negation that sat just outside the model's quote back into the quote.
 */
export function alignPiece(text: string, at: number, len: number): [number, number] | null {
  const end = at + len;
  if (isWordChar(text[at - 1]) && isWordChar(text[at])) return null;
  if (isWordChar(text[end - 1]) && isWordChar(text[end])) return null;
  let lo = at;
  let hi = end;
  for (const [s, e] of units(text)) {
    if (s <= at && at < e) lo = Math.min(lo, s);
    if (s < end && end <= e) hi = Math.max(hi, e);
  }
  return [lo, hi];
}

/** True when the text between two kept pieces is short and carries no negation. */
export function gapIsSafe(gap: string): boolean {
  return gap.length <= MAX_ELISION_GAP && !hasNegation(gap);
}

/**
 * Whether the returned quote agrees with the claim about polarity. Only units
 * that share content with the claim are compared, so an unrelated "not" in a
 * neighbouring sentence does not veto a good quote.
 */
export function polarityOf(claim: string, quoteUnits: string[]): { relevant: number; differs: boolean; substitution: boolean } {
  const claimStems = contentStems(claim);
  const claimNeg = hasNegation(claim);
  let relevant = 0;
  let differs = false;
  let substitution = false;
  for (const u of quoteUnits) {
    const stems = contentStems(u);
    if (shared(claimStems, stems) < MIN_SHARED_STEMS) continue;
    relevant += 1;
    if (hasNegation(u) !== claimNeg) differs = true;
    if ([...stems].some((s) => !claimStems.has(s)) && [...claimStems].some((s) => !stems.has(s))) substitution = true;
  }
  return { relevant, differs, substitution };
}
