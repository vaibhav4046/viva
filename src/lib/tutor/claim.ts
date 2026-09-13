import type { Course, ExamQuestion, Trap } from "@/lib/courses";
import { tokens } from "@/lib/retrieval";
import type { SourceChunk } from "@/lib/types";

/**
 * Checking a stated belief against the source.
 *
 * The landing page promises VIVA catches what you got wrong. Two failures had
 * to be fixed here at once, and they pull in opposite directions:
 *
 *   - the check contradicted students who were RIGHT. `overlapRatio` counted
 *     the trap's words appearing in the claim, so "mutually exclusive events
 *     cannot be independent" — a correct refutation, which necessarily reuses
 *     every noun in the misconception — scored as having made it;
 *   - the check missed almost everything else, because the only thing it could
 *     recognise was a trap the course author had written out by hand.
 *
 * So the checks below read the subject's own material rather than a list of
 * sentences: the terms it names, the counts it gives, the alternatives it
 * rules out. They work the same on a subject a student built from their notes
 * five minutes ago, which had no authored traps at all.
 *
 * Order, cheapest and most confident first. Every one of them is lexical and
 * model-free, so the verdict is the same every time:
 *
 *   0. is the learner DENYING a mistake rather than making one? then nothing
 *      below may assert a contradiction — this is the guard that protects the
 *      student who understands the material. Denying is not the same as
 *      drawing a contrast: "backprop and gradient descent are two different
 *      steps" believes its own sentence, and gating it here cost recall for
 *      nothing (`CONTRAST`);
 *   0b. does a passage already say the whole claim? then it is `supported` —
 *      the one status that may tell a learner they are right, because a line
 *      of their own source says the same thing in the same polarity;
 *   1. a trap the subject ships (the author wrote why it is wrong);
 *   2. conflation — "X and Y are the same" where the source separates them;
 *   2b. the same with one term — "the heads all learn the same thing" where
 *      the source says they specialise;
 *   3. the source rules it out in its own words ("…, not X", "instead of X",
 *      "has no X");
 *   4. term substitution — the source puts a different named thing in that slot;
 *   5. relation mismatch — X is <done> to Y, the source says Z, and a wrong
 *      operation counts as well as a wrong destination;
 *   6. nothing in the passages goes near it, so VIVA says so rather than guessing.
 *
 * Anything else comes back `consistent`, which means "not caught" and NEVER
 * "verified". The reply for that case must not tell a student their source
 * agrees with them: not finding a contradiction is not finding agreement.
 *
 * ponytail: every check is lexical, so a claim phrased entirely in the
 * student's own words can still slip past. That is the honest failure
 * direction — a miss says "I could not check that", it never asserts a false
 * correction. A model pass over the same passages is the upgrade if precision
 * ever needs to go higher.
 */

export type ClaimStatus = "contradicted" | "supported" | "unsupported" | "consistent";

export type ClaimCheck = {
  status: ClaimStatus;
  /** One sentence naming what the source actually says. */
  lead: string | null;
  /** The line that decides it, verbatim from the passage. */
  quote: string | null;
  chunkId: string | null;
  /** The question to ask next, from the subject's own question bank. */
  question: string | null;
  /** The bank question this turn opens, so the next turn can grade it. */
  openQuestion: ExamQuestion | null;
};

/**
 * The learner is denying, correcting or contrasting rather than asserting.
 * `\bnot\b` was the whole guard before, which cannot match inside "cannot" —
 * so the one spelling a confident student actually uses got them marked wrong.
 *
 * Contrast words are here bare rather than only as "different FROM". A student
 * separating two things writes "backpropagation and gradient descent are two
 * different steps", and requiring the preposition meant that sentence read as
 * an assertion that they are the same. Every use of this pattern widens the
 * set of sentences VIVA leaves alone, so a word too many costs a miss and
 * never a false correction.
 */
const NEGATED =
  /\b(not|never|no|isn['’]?t|aren['’]?t|can\s?not|cannot|can['’]t|won['’]?t|will\s+not|does\s?n['’]?t|do\s?n['’]?t|did\s?n['’]?t|wrong|false|myth|misconception|differs?|different(?:ly)?|distinct|separate(?:ly)?|unlike|rather\s+than|instead\s+of|as\s+opposed\s+to)\b/i;

/**
 * Contrast only — the other half of `NEGATED`. A student writing "backprop and
 * gradient descent are two different steps" is drawing a distinction inside a
 * sentence they believe, not denying it, and gating the passage checks on this
 * half cost recall for nothing: measured on the twenty-sentence corpus in
 * `tests/fixtures/claim-corpus.ts`, the wide gate blocked ONE of the ten wrong
 * sentences (a real "not") and nine of the ten correct contrast sentences. So
 * the gate below reads `DENIAL`, and contrast reaches the passage checks —
 * where the checks that could fire on it carry their own contrast guard.
 */
const CONTRAST = /\b(differs?|different(?:ly)?|distinct|separate(?:ly)?|unlike|rather\s+than|instead\s+of|as\s+opposed\s+to|whereas)\b/i;

/**
 * Denial only — the half of `NEGATED` that flips a sentence's truth rather
 * than drawing a contrast within it.
 *
 * The wide pattern cannot decide polarity: a passage line ending "produce
 * DIFFERENT representations" matched it, so "Positional encodings are NOT
 * added to the token embeddings" scored as the same polarity as the line
 * saying they are, and came back "That matches p.11". Widening the pattern is
 * safe everywhere it only suppresses a correction, and unsafe in the one place
 * it licenses an assertion, which is why that place gets its own test.
 */
const DENIAL =
  /\b(not|never|no|none|isn['’]?t|aren['’]?t|can\s?not|cannot|can['’]t|won['’]?t|will\s+not|does\s?n['’]?t|do\s?n['’]?t|did\s?n['’]?t|without|neither|nor|wrong|false)\b/i;

/** Sentence split that keeps abbreviations like "p.11" and "e.g." intact. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

/** Singular-ish, so "heads" and "head" are one word on both sides. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ss")) return w;
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function stemTokens(s: string): string[] {
  return tokens(s).map(stem);
}

function contentTokens(s: string): Set<string> {
  return new Set(stemTokens(s));
}

function overlapRatio(claim: string, against: string): number {
  const a = contentTokens(against);
  if (a.size === 0) return 0;
  const c = contentTokens(claim);
  let hits = 0;
  a.forEach((w) => { if (c.has(w)) hits += 1; });
  return hits / a.size;
}

function where(chunk: SourceChunk): string {
  if (chunk.locator.page) return `p.${chunk.locator.page}`;
  if (chunk.locator.section) return chunk.locator.section;
  return "your source";
}

function firstSentence(s: string): string {
  return sentencesOf(s)[0] ?? s;
}

/* ------------------------------------------------------------------ *
 * The subject's own vocabulary. Concept names and aliases are the only
 * terms VIVA is allowed to say the source "puts somewhere else", which
 * keeps a substitution finding to things the material actually names.
 * ------------------------------------------------------------------ */

type Term = { text: string; toks: string[]; concept: string };

function keyTerms(course: Course): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  const add = (raw: string, concept: string): void => {
    const text = raw.trim().toLowerCase();
    const toks = stemTokens(text);
    const key = toks.join(" ");
    if (!key || key.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ text, toks, concept });
  };
  for (const c of course.concepts) for (const raw of [c.name, ...c.aliases]) add(raw, c.id);
  // Longest first so "value iteration" wins over "value".
  return out.sort((a, b) => b.toks.length - a.toks.length || b.text.length - a.text.length);
}

type Mention = { key: string; text: string; at: number; len: number; concept: string };

/** Non-overlapping term hits, by token index, longest term first. */
function mentionsIn(toks: string[], terms: Term[]): Mention[] {
  const taken: boolean[] = new Array(toks.length).fill(false);
  const out: Mention[] = [];
  for (const term of terms) {
    const n = term.toks.length;
    for (let i = 0; i + n <= toks.length; i += 1) {
      let hit = true;
      for (let k = 0; k < n; k += 1) if (taken[i + k] || toks[i + k] !== term.toks[k]) { hit = false; break; }
      if (!hit) continue;
      for (let k = 0; k < n; k += 1) taken[i + k] = true;
      out.push({ key: term.toks.join(" "), text: term.text, at: i, len: n, concept: term.concept });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Two terms that are spellings of each other ("backprop"/"backpropagation"). */
function related(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * The same word, two spellings — but only when one grows out of the front of
 * the other. "backprop"/"backpropagation" yes; "dependent"/"independent" no,
 * which is a pair of opposites that a plain substring test calls identical.
 */
function sameWord(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * What makes a trap that trap: the words its statement uses that its OWN
 * correction does not.
 *
 * This is the mechanism the round-2 fix missed. A trap statement is mostly
 * topic nouns, and a correct sentence about the same topic necessarily reuses
 * every one of them, so "does the claim contain the trap's words" fires on
 * agreement and disagreement alike — the co-occurrence bug, once as
 * `overlapRatio` measuring the trap inside the claim, and again here as a
 * ratio compared against a correction with a different-sized vocabulary.
 *
 * Subtracting the correction cancels the topic. What survives is the part that
 * makes the sentence a mistake: "same"/"thing" for backprop vs gradient
 * descent, "important"/"cosmetic" for order vs importance. A claim has to
 * carry THAT to be making the mistake.
 */
export function trapTell(trap: Trap): Set<string> {
  return distinctive(trap.statement, trap.correct);
}

/** The words in `a` that `b` does not also use. */
function distinctive(a: string, b: string): Set<string> {
  const other = stemTokens(b);
  const out = new Set<string>();
  for (const w of stemTokens(a)) if (!other.some((c) => sameWord(c, w))) out.add(w);
  return out;
}

/** How much of a trap's tell the claim actually says. */
function tellCoverage(claim: string, tell: Set<string>): number {
  if (tell.size === 0) return 0;
  const said = contentTokens(claim);
  let hits = 0;
  tell.forEach((w) => { if (said.has(w)) hits += 1; });
  return hits / tell.size;
}

/** A claim has to say most of what makes the mistake a mistake. */
const TELL_FLOOR = 0.6;

const CTX = 4;

function ctxLeft(toks: string[], m: Mention): Set<string> {
  return new Set(toks.slice(Math.max(0, m.at - CTX), m.at));
}

function ctxRight(toks: string[], m: Mention): Set<string> {
  return new Set(toks.slice(m.at + m.len, m.at + m.len + CTX));
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  a.forEach((w) => { if (b.has(w)) n += 1; });
  return n;
}

type Line = { chunk: SourceChunk; line: string; toks: string[]; score: number };

/** Every passage sentence, best match to the claim first. */
function rankLines(chunks: SourceChunk[], claim: string): Line[] {
  const want = contentTokens(claim);
  const out: Line[] = [];
  for (const chunk of chunks) {
    for (const line of sentencesOf(chunk.text)) {
      const toks = stemTokens(line);
      const set = new Set(toks);
      let hits = 0;
      want.forEach((w) => { if (set.has(w)) hits += 1; });
      out.push({ chunk, line, toks, score: want.size === 0 ? 0 : hits / want.size });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The claim is already in the source. "A single attention head computes one
 * weighted average" is a sentence from the notes; nothing below may correct
 * it, and this is the one place VIVA is allowed to say a learner is right.
 *
 * Saying so is an assertion, so it carries the guards an assertion needs:
 *
 *   - eight tenths of the claim's own words are in ONE line of the passage,
 *     and every term the subject names in the claim is in that line;
 *   - the words are in the source's ARRANGEMENT, not merely its vocabulary.
 *     "A light-year is a unit of time, not distance" reuses five of the six
 *     words of a line reading "the light-year is a unit of distance … you
 *     would not arrive", so a bag of words endorsed the exact inversion of
 *     what the source says. Half the claim's adjacent pairs have to survive;
 *   - same polarity. "Positional encodings are NOT added to the token
 *     embeddings" shares every word with the line that says they are, and
 *     without this it would have come back "That matches p.11";
 *   - a whole sentence, not three nouns. "order attention permutation" is
 *     inside a passage line word for word and understands nothing.
 *
 * And every sentence of the claim, not the claim as one lump. A student who
 * quotes two consecutive lines of their own passage — the shape a judge hit
 * on the very first try — had each half of what they said matched against a
 * single line, so neither half could ever cover eight tenths of the whole.
 * The measured score for exactly that sentence was 0.75 against a bar of 0.80
 * while the passage it came out of was open beside it. Each part now finds its
 * own line and all of them must; a part too short to judge (a trailing "Not
 * really.") sinks the whole claim rather than riding along on the rest.
 */
const SUPPORT_MIN_WORDS = 6;

/** How much of the claim's own vocabulary the line repeats. */
const SUPPORT_MIN_COVER = 0.8;

/**
 * How many of the claim's adjacent word pairs the line repeats. Lower than the
 * word bar on purpose: a source line is allowed a parenthetical the student
 * left out ("Positional encodings (fixed sinusoidal patterns…) are added to…"),
 * which breaks the pairs either side of it without changing the sentence.
 */
const SUPPORT_MIN_PAIRS = 0.5;

/**
 * Tokens with the hyphen read as a space, for the support check only.
 *
 * `tokens` keeps it, so "self-attention" is one word that never matches a
 * student typing "self attention" — and the passages here are written with the
 * hyphens in. Splitting it everywhere was measured and rejected: it made
 * strategy 4 read "query-key-value" as the three terms it names and contradict
 * "Multi-head attention runs several heads in parallel", which is true and is
 * in the precision floor. Support asserts nothing the quoted line does not
 * say, so it can afford the looser reading that the shape-matching strategies
 * cannot.
 */
function looseTokens(s: string): string[] {
  return stemTokens(s.replace(/-/g, " "));
}

/** The same terms, read the same loose way, so the guard still bites. */
function looseTerms(terms: Term[]): Term[] {
  return terms
    .map((t) => ({ text: t.text, toks: looseTokens(t.text), concept: t.concept }))
    .sort((a, b) => b.toks.length - a.toks.length || b.text.length - a.text.length);
}

/** Adjacent word pairs — the cheapest test that a bag of words is a sentence. */
function pairs(toks: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < toks.length; i += 1) out.add(`${toks[i - 1]} ${toks[i]}`);
  return out;
}

/**
 * How much of `want` the line carries. `also` is a second set that counts as
 * carried — the other words the subject declares for the things this line
 * names, so an acronym is not read as a word the line is missing.
 */
function covered(want: Set<string>, have: Set<string>, also?: Set<string>): number {
  if (want.size === 0) return 0;
  let hits = 0;
  want.forEach((w) => { if (have.has(w) || also?.has(w)) hits += 1; });
  return hits / want.size;
}

/** Sentences of a claim, including the short ones `sentencesOf` drops. */
function claimParts(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Numbers, with the word that follows them. `tokens` drops anything under
 * three characters, so "70 mL" contributes nothing at all while "70 litres"
 * contributes one word — and one word is exactly what a 0.8 coverage bar can
 * afford to lose. Measured on a local server before this rule existed:
 * "each of the major pumping chambers ejects about 70 litres of blood per
 * contraction" came back *"That matches 19.1 Heart Anatomy"* over a line
 * reading 70 mL. A quantity is one word away from a different fact, so the
 * unit gets a rule of its own rather than a share of a ratio.
 */
const QUANTITY = /(\d[\d.,]*)\s*([a-zA-Zµμ%°]{1,20})?/g;

function quantities(s: string): { n: string; unit: string }[] {
  const out: { n: string; unit: string }[] = [];
  QUANTITY.lastIndex = 0;
  let m = QUANTITY.exec(s);
  while (m) {
    out.push({ n: m[1].replace(/[.,]$/, ""), unit: (m[2] ?? "").toLowerCase() });
    m = QUANTITY.exec(s);
  }
  return out;
}

/**
 * Every quantity the claim states has to be in the line, number and unit
 * both. Not a ratio and not a stem match: "millilitres" and "mL" are the same
 * measure and this rule still refuses them, which costs a confirmation VIVA
 * would have been right to give. A refusal says "I could not check that"; the
 * other way round tells a student their source agrees that a heart chamber
 * holds 70 litres.
 *
 * The number half was missing at first and an adversarial pass found what
 * that cost, on the shipped library and with no model involved: "each of the
 * major pumping chambers ejects approximately 700 mL blood per contraction"
 * came back *"That matches 19.1 Heart Anatomy"* over the line reading 70 mL,
 * and "stroke volume will normally be in the range of 700 mL" over the line
 * reading 70-80 mL. `tokens` drops "70" for being two characters long, so the
 * only thing separating the two sentences was one three-character token
 * against a bar that can afford to lose one in five.
 *
 * One direction only: what the CLAIM asserts must be in the line. A line
 * carrying numbers the claim never mentions is just a fuller sentence.
 */
function quantitiesAgree(claim: string, line: string): boolean {
  const words = new Set(line.toLowerCase().replace(/[^a-z0-9µμ%°\s]/g, " ").split(/\s+/));
  const said = quantities(line);
  const units = new Set(said.map((q) => q.unit).filter(Boolean));
  const numbers = new Set(said.map((q) => q.n));
  return quantities(claim).every((q) => numbers.has(q.n) && (!q.unit || units.has(q.unit) || words.has(q.unit)));
}

/**
 * Words that flip a sentence without denying anything, so `DENIAL` cannot see
 * them. Measured on the shipped library, again with no model involved:
 * "Friction is a force that RARELY opposes the motion past each other of
 * objects that are touching" came back *"That matches 4.3 …"* over the line
 * defining friction as a force that opposes it, and so did the same sentence
 * with "fails to oppose". One hedge is one token, and one token is what a 0.8
 * coverage bar is built to forgive.
 *
 * Kept to the hedges that reverse a statement outright. "little", "few" and
 * "except" reverse some sentences and merely qualify others, and every word
 * on this list costs a real confirmation somewhere.
 */
const HEDGED = /\b(rarely|seldom|hardly|scarcely|barely|almost\s+never|fails?\s+to|failed\s+to|unable\s+to)\b/i;

/** Negative in either of the two ways a sentence can be. */
function negative(s: string): boolean {
  return DENIAL.test(s) || HEDGED.test(s);
}

type Support = { chunk: SourceChunk; line: string; score: number };

/** The last word of a term — "ordering invariant" is a kind of invariant. */
function head(key: string): string {
  const w = key.split(" ");
  return w[w.length - 1];
}

/**
 * What the line calls the things it names: the terms themselves, the concepts
 * behind them, and every other word the subject declares for those same
 * concepts.
 *
 * A source is allowed to call something by one of its other names. The notes
 * write "The turnover number kcat is Vmax divided by…" and then, in the next
 * sentence, "The turnover number is the number of substrate molecules…", so a
 * student who types the acronym is naming the thing that line names. Reading
 * `kcat` as a word the line simply lacks cost the sentence one word in twelve
 * against a bar that forgives one in five, and the judge got "I could not
 * check that" over a passage ending in their own sentence.
 *
 * Only forms the SUBJECT declares are credited. Nothing here invents a synonym.
 */
type Names = { keys: Set<string>; concepts: Set<string>; words: Set<string> };

function namesOf(lineToks: string[], terms: Term[]): Names {
  const mentions = mentionsIn(lineToks, terms);
  const keys = new Set(mentions.map((m) => m.key));
  const concepts = new Set(mentions.map((m) => m.concept));
  const words = new Set<string>();
  for (const t of terms) if (concepts.has(t.concept)) for (const w of t.toks) words.add(w);
  return { keys, concepts, words };
}

/** The one line of the passage that says this sentence back. */
function supportsSentence(part: string, chunks: SourceChunk[], terms: Term[]): Support | null {
  const partToks = looseTokens(part);
  const want = new Set(partToks);
  if (want.size < SUPPORT_MIN_WORDS) return null;
  const wantPairs = pairs(partToks);
  const denied = negative(part);
  // Every term the subject names in this sentence, which the line has to name
  // too — the same term, or a recognisable form of it.
  //
  // Demanding the identical phrase was too strict in two ways. The source
  // writes "a query (what this token is looking for), a key …, and a value …",
  // so the concept "queries, keys, values" never sits together in it, and the
  // line that said the claim word for word was thrown away — that is the
  // every-word-of-it fallback. And a source that writes "the invariant" is
  // naming the same thing as a claim that says "ordering invariant": better
  // concept names out of a student's own notes made more phrases into terms
  // the line then had to repeat verbatim, so improving intake made this
  // refusal likelier on exactly the material a student wrote themselves.
  //
  // Accepting bare words was too loose, and that guard survives here. "Value
  // iteration alternates policy evaluation and policy improvement" is wrong,
  // and both words of "value iteration" turn up in the line saying POLICY
  // iteration does that. The head-noun reading is what would let it past, so
  // it is refused whenever the line names some OTHER thing of the same kind:
  // that line names "policy iteration", which is an iteration too, so the
  // claim's "value iteration" is not what the line is talking about.
  const named = mentionsIn(partToks, terms);
  let best: Support | null = null;
  for (const chunk of chunks) {
    for (const line of sentencesOf(chunk.text)) {
      const lineToks = looseTokens(line);
      const inLine = new Set(lineToks);
      const says = namesOf(lineToks, terms);
      const score = covered(want, inLine, says.words);
      if (score < SUPPORT_MIN_COVER || (best && score <= best.score)) continue;
      if (covered(wantPairs, pairs(lineToks)) < SUPPORT_MIN_PAIRS) continue;
      if (denied !== negative(line)) continue;
      if (!quantitiesAgree(part, line)) continue;
      if (!named.every((m) => knownAs(m, says, inLine))) continue;
      best = { chunk, line, score };
    }
  }
  return best;
}

/** The line names this term, or a form of it the subject already declares. */
function knownAs(m: Mention, says: Names, inLine: Set<string>): boolean {
  if (says.keys.has(m.key)) return true;
  // Every word of it is a term of its own in the line ("queries", "keys",
  // "values" for the concept "queries, keys, values").
  const parts = m.key.split(" ");
  if (parts.every((w) => says.keys.has(w))) return true;
  // NOT "the line names the same concept". Measured, and it confirmed two
  // false sentences: a subject may file two contrasting things under one
  // concept — "Policy vs value iteration" lists both as aliases, and
  // "Backpropagation" lists "gradient descent" — so same-concept read
  // "Value iteration alternates policy evaluation and policy improvement" and
  // "Gradient descent applies the chain rule…" as matching the lines that say
  // the opposite. Sameness of concept is not sameness of thing.
  //
  // Its head noun, unless the line puts a different named thing of the same
  // kind there — "policy iteration" is what stops "value iteration".
  const h = head(m.key);
  if (!inLine.has(h)) return false;
  for (const k of says.keys) if (k !== m.key && head(k) === h) return false;
  return true;
}

function supportedBy(claim: string, chunks: SourceChunk[], terms: Term[]): Support | null {
  const loose = looseTerms(terms);
  // One dense line can say the whole thing at once — that was the only shape
  // this check ever recognised, and it stays first because it is the cheapest.
  const whole = supportsSentence(claim, chunks, loose);
  if (whole) return whole;
  const parts = claimParts(claim);
  if (parts.length < 2) return null;
  // Otherwise every sentence of the claim finds its own line, or none of it
  // counts. Not "most of it": a true paragraph with one invented sentence in
  // it must not come back as a match.
  let best: Support | null = null;
  for (const part of parts) {
    const hit = supportsSentence(part, chunks, loose);
    if (!hit) return null;
    if (!best || hit.score > best.score) best = hit;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Why the model does not get to do this half.
 *
 * The obvious next move is to let the model NOMINATE the line it says states
 * the learner's sentence and have the server check the nomination — the same
 * split the product uses for citations. It was built and measured, and the
 * checks a server can actually run on a nominated line are: the quote is in
 * that passage word for word, the id is one that was retrieved, the line and
 * the claim name a concept in common, polarity agrees, quantities agree. None
 * of those is entailment, and an adversarial pass over the shipped library
 * walked through all of them:
 *
 *   "Demand is the total quantity of a good that PRODUCERS are willing to
 *   SELL at each price" was confirmed by the line "We defined demand as the
 *   amount of some product a CONSUMER is willing and able to PURCHASE at each
 *   price" — the definition it inverts, in the retrieved set, quoted verbatim.
 *   "In a relation, the domain is the set of the SECOND components" was
 *   confirmed by the line saying the domain is the FIRST components and the
 *   range the second. Seven shapes in all, including a rhetorical question in
 *   the notes used as evidence, and a claim whose first sentence was true and
 *   second sentence invented.
 *
 * Tightening the gate until those fail means requiring most of the claim's own
 * words in the line, which is `supportsSentence` again — and at those bars the
 * paraphrases the whole idea existed to catch ("positional encodings are added
 * to the token embeddings so the model can tell which token came first" covers
 * 0.55 of its line) fail too. There is no bar between the two.
 *
 * So a paraphrase gets "I could not check that against your source", which is
 * true, and the confirmation stays with the lexical check below, which can
 * show the line it rests on. Anything better needs a check that reads meaning
 * — a model asked to judge entailment is the model agreeing with itself, so it
 * is not that either.
 * ------------------------------------------------------------------ */

/**
 * The two sentences VIVA says when a line of the learner's own source says
 * their sentence back. One spelling for both paths — the lexical check and the
 * model nomination — because a student must not be able to tell which one
 * answered them.
 */
export function matchesLead(chunk: SourceChunk): string {
  return `That matches ${where(chunk)} —`;
}

export function passageSays(line: string): string {
  return `The passage says: “${line.slice(0, 220)}”`;
}

/** The passage line closest to a reference sentence. */
function bestLine(chunks: SourceChunk[], reference: string): { chunk: SourceChunk; line: string } | null {
  let best: { chunk: SourceChunk; line: string; score: number } | null = null;
  for (const chunk of chunks) {
    for (const line of sentencesOf(chunk.text)) {
      const score = overlapRatio(line, reference);
      if (!best || score > best.score) best = { chunk, line, score };
    }
  }
  return best && best.score > 0 ? { chunk: best.chunk, line: best.line } : null;
}

/**
 * "X is/are <verb>ed <prep> Y" — the shape of a claim that puts something in
 * the wrong place. Returns the head, the verb phrase and the complement.
 */
const RELATION = /\b([a-z][\w' -]{2,60}?)\s+(?:is|are|gets?|get)\s+([a-z]+(?:ed|en))\s+(to|into|onto|from|by|with|after|before|through)\s+([^.;]{3,90})/i;

type Relation = { head: string; verb: string; prep: string; object: string };

/**
 * Operations grouped by what they do, so a wrong one is comparable.
 *
 * Strategy 5 used to compare verbs by string, which meant it could only catch
 * the right operation in the wrong place ("positional encoding is ADDED TO the
 * attention weights") and never the wrong operation ("positional encodings are
 * MULTIPLIED WITH the attention scores"), because a different verb produced no
 * comparison at all rather than a mismatch.
 *
 * Only verbs in this table are comparable: an unlisted verb still needs an
 * exact string match, so two unrelated true sentences about one subject cannot
 * become a contradiction just because they use different words. Across all
 * thirteen shipped subjects exactly one source relation is classified, which
 * is the honest size of this lever.
 */
const VERB_CLASS: Record<string, string> = {
  added: "sum", summed: "sum", concatenated: "sum", appended: "sum",
  multiplied: "scale", scaled: "scale", divided: "scale",
  replaced: "swap", substituted: "swap",
  removed: "drop", deleted: "drop", discarded: "drop",
};

/** Same operation family, or unclassified and therefore only itself. */
function sameOperation(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = VERB_CLASS[a];
  const cb = VERB_CLASS[b];
  return ca !== undefined && ca === cb;
}

/** Both named, and named as different things to do. */
function clashingOperation(a: string, b: string): boolean {
  const ca = VERB_CLASS[a];
  const cb = VERB_CLASS[b];
  return ca !== undefined && cb !== undefined && ca !== cb;
}

export function readRelation(text: string): Relation | null {
  const m = RELATION.exec(text.replace(/\([^)]*\)/g, " "));
  if (!m) return null;
  return { head: m[1].trim(), verb: m[2].toLowerCase(), prep: m[3].toLowerCase(), object: trimClause(m[4]) };
}

/**
 * Cut a complement at the first clause boundary and cap it at six words.
 *
 * "instead of" and "rather than" are boundaries too: without them the reply
 * to "…multiplied with the attention scores instead of the token embeddings"
 * ended "not multiplied with the attention scores instead of the", which is a
 * sentence VIVA cannot finish.
 */
function trimClause(s: string): string {
  const cut = s.split(/\s+(?:so\s+that|so|which|because|and|while|whereas|when|instead\s+of|rather\s+than)\s+/i)[0];
  return cut.replace(/[,;].*$/, "").trim().split(/\s+/).slice(0, 6).join(" ").replace(/[.\s]+$/, "");
}

function disjoint(a: string, b: string): boolean {
  const bt = contentTokens(b);
  for (const w of contentTokens(a)) if (bt.has(w)) return false;
  return true;
}

/** The bank question for a concept — the Socratic move after a correction. */
function probeFor(course: Course, conceptId: string | null): ExamQuestion | null {
  return course.examQuestions.find((q) => q.conceptId === conceptId) ?? null;
}

const CONSISTENT: ClaimCheck = { status: "consistent", lead: null, quote: null, chunkId: null, question: null, openQuestion: null };

/**
 * "A and B are the same thing" / "A is just B" — an equation of two things.
 *
 * `HEDGE` is the reason "the query and the value are ALWAYS identical vectors"
 * was invisible: one adverb between the verb and the equator, and the whole
 * conflation check stopped applying to a sentence built out of nothing else.
 */
const HEDGE = "(?:always\\s+|really\\s+|basically\\s+|essentially\\s+|effectively\\s+|just\\s+|simply\\s+|all\\s+|both\\s+|pretty\\s+much\\s+)?";
const EQUATES: RegExp[] = [
  new RegExp(`([\\w'’ -]{3,44}?)\\s+and\\s+([\\w'’ -]{3,44}?)\\s+are\\s+${HEDGE}(?:the\\s+same|identical|equivalent|interchangeable)\\b`, "i"),
  new RegExp(`([\\w'’ -]{3,44}?)\\s+is\\s+${HEDGE}(?:the\\s+same\\s+(?:thing\\s+)?as|identical\\s+to|just|simply|another\\s+(?:word|name)\\s+for)\\s+([\\w'’ -]{3,44})`, "i"),
];

/**
 * The claim says instances of ONE thing do not differ — "the heads all learn
 * the same thing", "multi-head attention just runs the same attention twice".
 *
 * `EQUATES` needs two named things to conflate and these sentences name one,
 * so they fell through every check and came back "I could not check that" on
 * material the source contradicts twice (p.15, p.16). The finding is the same
 * finding conflation makes, with the claim on both sides of it.
 */
const UNIFORM = /\b(?:the\s+same|identical|interchangeable)\b/i;

/** Saying the copies are pointless is the whole mistake, on its own. */
const REDUNDANT = /\b(?:redundant|duplicates?|copies|clones?|no\s+different)\b/i;

/**
 * What separates the mistake from a description. "Multi-head attention runs
 * the same computation h times in parallel" is a fair paraphrase of p.15 and
 * says `the same`; "multi-head attention JUST runs the same attention twice"
 * is the misconception. The reductive word is the difference, so uniformity
 * needs one before it may contradict anybody.
 */
const REDUCTIVE = /\b(?:just|only|merely|simply|all|nothing\s+but|no\s+more\s+than)\b/i;

/**
 * Both halves in ONE clause, not merely somewhere in the same paragraph.
 *
 * A concept description that opens "ALL substances must be electrically
 * neutral" and closes, two sentences later, "…give IDENTICAL numbers of
 * positive and negative charges" is a true sentence flattening nothing, and
 * a paragraph-wide test contradicted it.
 */
function flattensSomething(claim: string): boolean {
  return clausesOf(claim).some((c) => REDUNDANT.test(c) || (UNIFORM.test(c) && REDUCTIVE.test(c)));
}

/** The source saying two things are not one thing. */
const DISTINCT = /\b(different|differs|differ|separate|distinct|two|three|four|both|whereas|instead|rather\s+than|confus\w+|not\s+the\s+same)\b/i;

/**
 * The source ruling an alternative out in its own words, in favour of the
 * thing it just said. The comma is excluded from the capture so the ruled-out
 * side stops at its own clause instead of swallowing the rest of the sentence.
 */
const RULES_OUT = /(?:,\s*not\s+|\binstead\s+of\s+|\brather\s+than\s+)([^.;:,]{2,60})/gi;

/**
 * The source denying something outright — "a standard Transformer HAS NO
 * recurrence". There is no affirmed alternative in this shape, only the
 * denial, so it is read separately: treating the words in front of it as the
 * affirmed side made the subject of the sentence ("Transformer") count as
 * agreement and cancelled the finding on "Transformers use recurrence".
 */
const DENIES = /\b(?:has|have|had|uses|use|contains?|includes?)\s+no\s+([^.;:,]{2,60})/gi;

export function checkClaim(input: {
  claim: string;
  chunks: SourceChunk[];
  course: Course;
  conceptId: string | null;
}): ClaimCheck {
  const { claim, chunks, course, conceptId } = input;
  const probe = probeFor(course, conceptId);
  const ask = (extra: Partial<ClaimCheck>): ClaimCheck => ({
    ...CONSISTENT,
    question: probe?.question ?? null,
    openQuestion: probe ?? null,
    ...extra,
  });
  const caught = (lead: string, l: { chunk: SourceChunk; line: string }): ClaimCheck =>
    ask({ status: "contradicted", lead, quote: l.line, chunkId: l.chunk.id });

  const terms = keyTerms(course);
  const claimToks = stemTokens(claim);
  const lines = rankLines(chunks, claim);
  const near = lines.filter((l) => l.score >= 0.3).slice(0, 3);

  // 0. A sentence the source already states cannot be contradicted by the
  //    source. This guard, and the polarity checks below it, are what protect
  //    the student who is right; skipping them is how "mutually exclusive
  //    events cannot be independent" got answered with "Not quite —".
  const support = supportedBy(claim, chunks, terms);

  if (support) {
    return ask({
      status: "supported",
      lead: matchesLead(support.chunk),
      quote: support.line,
      chunkId: support.chunk.id,
    });
  }

  {
    // 1. A trap the subject's author already wrote down. Four ways out of it,
    //    all of them the same question: is the learner making this mistake, or
    //    naming it? The claim must be on the trap's topic, say the words that
    //    make the mistake a mistake (`trapTell` — the guard the co-occurrence
    //    bug kept getting past), read more like the mistake than like the
    //    correction, and not flip the trap's own polarity.
    const scoped = course.traps.filter((t) => t.conceptId === conceptId);
    const pool = conceptId ? scoped : course.traps;
    for (const trap of pool) {
      if (overlapRatio(claim, trap.statement) < 0.6) continue;
      const mistake = tellCoverage(claim, trapTell(trap));
      if (mistake < TELL_FLOOR) continue;
      // And the claim must not read more like the correction than like the
      // mistake. Some traps distinguish themselves by a single word ("only",
      // "always", "same"), where the tell alone is thin; this is the symmetric
      // half of the same test, and it can never block a trap from firing on
      // its own statement, whose overlap with the correction's tell is zero.
      if (tellCoverage(claim, distinctive(trap.correct, trap.statement)) >= mistake) continue;
      if (overlapRatio(claim, trap.correct) >= overlapRatio(claim, trap.statement)) continue;
      if (negatedAbout(claim, trap.statement) !== negatedAbout(trap.statement, trap.statement)) continue;
      const line = bestLine(chunks, trap.correct) ?? bestLine(chunks, trap.statement);
      // No passage backs the correction: say we cannot place it rather than
      // asserting a contradiction with nothing to show for it.
      if (!line) break;
      return caught(`Not quite — ${firstSentence(trap.whyWrong)}`, line);
    }
  }

  // Denying something is not asserting it. The passage-shaped checks below
  // have no authored correction to compare against, so a claim carrying a
  // denial is left for the honest "I could not check that" reply. Contrast is
  // not denial and no longer gates here — see `CONTRAST`.
  const asserting = !DENIAL.test(claim);
  const contrasting = CONTRAST.test(claim);

  if (asserting) {

    // 2. Conflation: the claim equates two things the source keeps apart.
    for (const re of EQUATES) {
      const m = re.exec(claim);
      if (!m) continue;
      const a = lastTermIn(m[1], terms);
      const b = lastTermIn(m[2], terms);
      if (!a || !b || related(a.key, b.key)) continue;
      const names = lines.filter((l) => hasTerm(l.toks, a) && hasTerm(l.toks, b));
      // Quote the line that does the separating if there is one; a line whose
      // chunk says it elsewhere still shows the two treated as two.
      const hit = names.find((l) => DISTINCT.test(l.line)) ?? names.find((l) => DISTINCT.test(l.chunk.text));
      if (hit) return caught(`Not quite — ${where(hit.chunk)} treats ${a.text} and ${b.text} as different things.`, hit);
    }

    // 2b. The same move with one term: the claim flattens a thing the source
    //     says varies. Skipped when the claim itself draws a contrast, which
    //     is the sentence of a student who has the distinction and is stating
    //     it ("backprop and gradient descent are two different steps") — the
    //     one case where firing here would be worse than any miss.
    // Narrowed to the unambiguous half after an audit measured the cost of the
    // other one. `UNIFORM + REDUCTIVE` ("all the heads use the same X") fired
    // on any passage line that merely contained a contrast word and a related
    // term, without ever checking that the line addressed the property being
    // flattened — so "All the heads read the same input embeddings" and "All
    // the heads use the same scaling factor" were both contradicted by the
    // same quote about heads specialising. Both are true. So was "So um the
    // heads are all the same size I think", which is the register this product
    // is built to receive.
    //
    // `REDUNDANT` ("redundant", "duplicates", "copies", "clones") is a claim
    // that the copies are pointless, which the source does refute directly.
    // That half stays; the other half costs a real recall point and is not
    // worth what it was charging. A student told they are wrong when they are
    // right stops trusting the one thing this product sells.
    if (!contrasting && REDUNDANT.test(claim)) {
      for (const q of mentionsIn(claimToks, terms)) {
        // Any sentence of the retrieved passages, best-scoring first, rather
        // than only the closest three. The line that answers "the heads are
        // all the same" is "different heads specialise", which shares almost
        // no words with it and scored zero — the sentence that refutes you is
        // not the sentence that repeats you.
        const hit = lines.find((l) => DISTINCT.test(l.line) && mentionsIn(l.toks, terms).some((p) => related(p.key, q.key)));
        if (hit) return caught(`Not quite — ${where(hit.chunk)} treats them as different.`, hit);
      }
    }

    // 3 and 4 keep the wider gate. Both carry guards written against specific
    // past false positives, and letting contrast through them was measurably
    // worse: two OpenStax asides ("Confused about these different types of
    // demand?") started being contradicted, against nothing gained. Contrast
    // reaches 2, 2b and 5, where it earns its keep and costs nothing.
    const shaped = !contrasting;

    // 3. The source rules the claim out in its own words: "…, not X",
    //    "instead of X", "rather than X". The author already did the work.
    for (const l of shaped ? near : []) {
      const ruled = ruledOut(l);
      if (ruled.out.size === 0) continue;
      const claimSet = new Set(claimToks);
      let asserts = false;
      ruled.out.forEach((w) => { if (claimSet.has(w)) asserts = true; });
      if (!asserts) continue;
      // The claim states the side the source affirms as well, so it is
      // discussing the contrast rather than falling for it.
      let affirms = false;
      ruled.affirmed.forEach((w) => { if (claimSet.has(w)) affirms = true; });
      if (affirms) continue;
      // Shared context EXCLUDING the ruled-out word, so a sentence that merely
      // reuses the word ("one weighted average") is not a contradiction.
      const lineSet = new Set(l.toks);
      let context = 0;
      claimSet.forEach((w) => { if (!ruled.out.has(w) && lineSet.has(w)) context += 1; });
      if (context >= 2) return caught(`Not quite — ${where(l.chunk)} rules that out.`, l);
    }

    // 4. Term substitution: same frame, a different thing in the slot. The
    //    source says the score is scaled by the square root of the KEY
    //    DIMENSION; the claim says the number of HEADS.
    for (const l of shaped ? near : []) {
      const inLine = mentionsIn(l.toks, terms);
      const lineKeys = new Set(inLine.map((m) => m.key));
      const inClaim = mentionsIn(claimToks, terms);
      const claimKeys = new Set(inClaim.map((m) => m.key));
      for (const q of inClaim) {
        // The line itself names that term, so the claim is on topic for it
        // rather than putting it where something else belongs.
        if (lineKeys.has(q.key)) continue;
        for (const p of inLine) {
          if (claimKeys.has(p.key) || related(p.key, q.key)) continue;
          const left = shared(ctxLeft(claimToks, q), ctxLeft(l.toks, p));
          const right = shared(ctxRight(claimToks, q), ctxRight(l.toks, p));
          if (Math.max(left, right) < 2) continue;
          // Quoted, because on a subject VIVA read itself the terms are the
          // learner's own words and read oddly in a bare sentence.
          return caught(`Not quite — ${where(l.chunk)} puts “${p.text}” there, not “${q.text}”.`, l);
        }
      }
    }

    // 5. Relation mismatch: the source puts the same thing somewhere else.
    const said = readRelation(claim);
    if (said) {
      for (const chunk of chunks) {
        for (const line of sentencesOf(chunk.text)) {
          const src = readRelation(line);
          if (!src) continue;
          // Same subject being talked about, or the two sentences are not
          // about the same thing at all.
          if (disjoint(src.head, said.head)) continue;
          // The source must deny the operation, not merely name a different
          // one. "Positional encodings are added to the token embeddings" and
          // "positional encodings are scaled by a constant factor" are both
          // true — a vector can be scaled and added — but a bare verb-class
          // difference read them as a contradiction and produced a non
          // sequitur. Require the claim and the source to be talking about the
          // same object before a difference in verb means anything.
          const srcObj = new Set(stemTokens(src.object));
          const sameObject = stemTokens(said.object).some((t) => srcObj.has(t));
          const clash = sameObject && clashingOperation(src.verb, said.verb);
          if (clash) {
            return caught(
              `Not quite — ${where(chunk)} says ${src.head} are ${src.verb} ${src.prep} ${src.object}, not ${said.verb} ${said.prep} ${said.object}.`,
              { chunk, line }
            );
          }
          // Same operation, somewhere else. The preposition stays a gate here:
          // with the verb matching it is all that separates "added to" from
          // "added after", and the object comparison assumes the same frame.
          if (!sameOperation(src.verb, said.verb) || src.prep !== said.prep) continue;
          if (!disjoint(src.object, said.object)) continue;
          return caught(
            `Not quite — ${where(chunk)} says ${src.head} are ${src.verb} ${src.prep} ${src.object}, not ${said.object}.`,
            { chunk, line }
          );
        }
      }
    }
  }

  // 6. Nothing in the passages is about this. Say so; do not guess, and do not
  //    file it under whatever retrieval happened to return.
  const claimTokens = contentTokens(claim);
  if (claimTokens.size > 0) {
    let touched = 0;
    for (const chunk of chunks) {
      const ct = contentTokens(chunk.text);
      let hits = 0;
      claimTokens.forEach((w) => { if (ct.has(w)) hits += 1; });
      touched = Math.max(touched, hits / claimTokens.size);
    }
    if (touched < 0.2) {
      return ask({
        status: "unsupported",
        // Any sentence that is not a question now reaches this check, so this
        // line also answers a stray note. It says both true things: VIVA did
        // not check it, and it did not throw it away.
        lead: "That is not in this subject — I can only check what your passages cover, so it is kept as a note, unchecked.",
      });
    }
  }

  return ask({});
}

/** The last key term named inside a fragment ("queries and keys" → keys). */
function lastTermIn(fragment: string, terms: Term[]): { key: string; text: string } | null {
  const found = mentionsIn(stemTokens(fragment), terms);
  const m = found[found.length - 1];
  return m ? { key: m.key, text: m.text } : null;
}

function hasTerm(toks: string[], t: { key: string }): boolean {
  return toks.join(" ").includes(t.key);
}

/**
 * What the passage explicitly rules out ("…, not X" / "instead of X") and what
 * it affirms in the same breath. Both halves matter: a claim that also states
 * the affirmed side is discussing the contrast, not walking into it.
 */
function ruledOut(l: Line): { out: Set<string>; affirmed: Set<string> } {
  const out = new Set<string>();
  const affirmed = new Set<string>();
  RULES_OUT.lastIndex = 0;
  let m = RULES_OUT.exec(l.line);
  while (m) {
    for (const w of stemTokens(m[1]).slice(0, 4)) out.add(w);
    for (const w of stemTokens(l.line.slice(0, m.index)).slice(-4)) affirmed.add(w);
    m = RULES_OUT.exec(l.line);
  }
  DENIES.lastIndex = 0;
  let d = DENIES.exec(l.line);
  while (d) {
    for (const w of stemTokens(d[1]).slice(0, 4)) out.add(w);
    d = DENIES.exec(l.line);
  }
  return { out, affirmed };
}

/** Clauses, so a negation can be tied to the part of the sentence it governs. */
function clausesOf(s: string): string[] {
  return s
    .split(/[,;:]|\s+(?:so|because|but|which|while|whereas|therefore|and\s+so)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Is the part of `text` that talks about `reference` a denial?
 *
 * The blunt version of this — "the sentence contains the word not" — is why a
 * misconception that ends "…so the order does not matter" escaped its own
 * trap, and comparing polarity against the trap's own wording is what lets
 * both that and "mutually exclusive events cannot be independent" come out
 * right: one matches the trap's polarity, the other flips it.
 */
function negatedAbout(text: string, reference: string): boolean {
  const parts = clausesOf(text);
  let best = text;
  let score = -1;
  for (const part of parts) {
    const s = overlapRatio(part, reference);
    if (s > score) { score = s; best = part; }
  }
  return NEGATED.test(best);
}

/**
 * A "correction" that is the learner's own sentence back.
 *
 * Measured against the live provider on 13 Sep, three cold runs out of three:
 * "Multi-head attention just runs the same attention twice to make it faster"
 * — which is false, and which the lexical checks are recorded as missing —
 * came back *"It runs the same attention twice to make it faster."* as the
 * correction, and the map moved down. So the reply asserted the misconception
 * in VIVA's own voice while filing the learner as wrong about it.
 *
 * `groundReply` already deletes `right` for this reason: the model echoing the
 * learner is not a check. `wrong` had no such guard, and it is the more
 * dangerous half, because the echo of a FALSE sentence reads as VIVA agreeing.
 *
 * The test is deliberately absolute rather than a ratio: a correction that
 * introduces no word the learner did not already use cannot be correcting
 * anything. One new word ("in parallel" for "twice") is a real correction and
 * survives. A denial is the exception a ratio would get wrong — "…does NOT run
 * the same attention twice" reuses every content word on purpose — so polarity
 * is read first.
 */
export function echoesClaim(correction: string | null, claim: string): boolean {
  if (!correction?.trim() || !claim.trim()) return false;
  if (DENIAL.test(correction) !== DENIAL.test(claim)) return false;
  const said = contentTokens(correction);
  if (said.size === 0) return false;
  const heard = contentTokens(claim);
  for (const w of said) if (!heard.has(w)) return false;
  return true;
}

/**
 * The reply a checked claim earns: what the source says, the line that shows
 * it, and a question. A correction with no question is a lecture, so when the
 * subject has no bank question for that concept the probe is generic rather
 * than absent.
 */
const FALLBACK_PROBE = "What would you change in your sentence so it matches that line?";

/**
 * The same correction, delivered without taking the open question away.
 *
 * A question used to swallow every later sentence: a flatly false claim typed
 * while one was open was graded as an attempt at the question and never
 * checked against the passage that disproves it. It is checked first now, and
 * the question is still there afterwards, so neither turn costs the other.
 */
export function composeInterruptReply(check: ClaimCheck, openQuestion: string): string {
  const lead = (check.lead ?? "").replace(/^Not quite\s*—\s*/, "");
  return [
    lead ? `Before that — ${lead}` : "Before that —",
    check.quote ? passageSays(check.quote) : null,
    `The question still stands: ${openQuestion}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function composeClaimReply(check: ClaimCheck, conceptName: string | null): string {
  const parts: string[] = [];
  if (check.lead) parts.push(check.lead);
  if (check.quote) parts.push(passageSays(check.quote));
  if (check.question) parts.push(check.question);
  else if (check.status === "contradicted") parts.push(FALLBACK_PROBE);
  else if (check.status === "supported") parts.push("Say the next step of it and I will check that line too.");
  if (parts.length === 0) {
    parts.push(
      `That is your position on ${conceptName ?? "this"} — let's test it rather than file it.`,
      "Say it back with the reason attached and I will check it line by line."
    );
  }
  return parts.join(" ");
}
