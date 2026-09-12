import type { Course, ExamQuestion } from "@/lib/courses";
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
 *   0. is the learner denying a mistake rather than making one? then nothing
 *      below may assert a contradiction — this is the guard that protects the
 *      student who understands the material;
 *   0b. does a passage already say the whole claim? then it is supported and
 *      nothing below may contradict it;
 *   1. a trap the subject ships (the author wrote why it is wrong);
 *   2. conflation — "X and Y are the same" where the source separates them;
 *   3. the source rules it out in its own words ("…, not X", "instead of X");
 *   4. term substitution — the source puts a different named thing in that slot;
 *   5. relation mismatch — X is <done> to Y, the source says Z;
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

export type ClaimStatus = "contradicted" | "unsupported" | "consistent";

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
 */
const NEGATED =
  /\b(not|never|no|isn['’]?t|aren['’]?t|can\s?not|cannot|can['’]t|won['’]?t|will\s+not|does\s?n['’]?t|do\s?n['’]?t|did\s?n['’]?t|wrong|false|myth|misconception|differs?\s+from|different\s+from|unlike|rather\s+than|instead\s+of|as\s+opposed\s+to)\b/i;

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

type Term = { text: string; toks: string[] };

function keyTerms(course: Course): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const c of course.concepts) {
    for (const raw of [c.name, ...c.aliases]) {
      const text = raw.trim().toLowerCase();
      const toks = stemTokens(text);
      const key = toks.join(" ");
      if (!key || key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      out.push({ text, toks });
    }
  }
  // Longest first so "value iteration" wins over "value".
  return out.sort((a, b) => b.toks.length - a.toks.length || b.text.length - a.text.length);
}

type Mention = { key: string; text: string; at: number; len: number };

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
      out.push({ key: term.toks.join(" "), text: term.text, at: i, len: n });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Two terms that are spellings of each other ("backprop"/"backpropagation"). */
function related(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a);
}

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
 * weighted average" is a sentence from the notes; nothing below may correct it.
 */
function isSupported(claim: string, lines: Line[], terms: Term[]): boolean {
  const top = lines[0];
  if (!top || top.score < 0.8) return false;
  const inLine = new Set(mentionsIn(top.toks, terms).map((m) => m.key));
  return mentionsIn(stemTokens(claim), terms).every((m) => inLine.has(m.key));
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

export function readRelation(text: string): Relation | null {
  const m = RELATION.exec(text.replace(/\([^)]*\)/g, " "));
  if (!m) return null;
  return { head: m[1].trim(), verb: m[2].toLowerCase(), prep: m[3].toLowerCase(), object: trimClause(m[4]) };
}

/** Cut a complement at the first clause boundary and cap it at six words. */
function trimClause(s: string): string {
  const cut = s.split(/\s+(?:so\s+that|so|which|because|and|while|whereas|when)\s+/i)[0];
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

/** "A and B are the same thing" / "A is just B" — an equation of two things. */
const EQUATES: RegExp[] = [
  /([\w'’ -]{3,44}?)\s+and\s+([\w'’ -]{3,44}?)\s+are\s+(?:the\s+same|identical|equivalent|interchangeable)\b/i,
  /([\w'’ -]{3,44}?)\s+is\s+(?:the\s+same\s+(?:thing\s+)?as|identical\s+to|just|simply|another\s+(?:word|name)\s+for)\s+([\w'’ -]{3,44})/i,
];

/** The source saying two things are not one thing. */
const DISTINCT = /\b(different|differs|differ|separate|distinct|two|three|four|both|whereas|instead|rather\s+than|confus\w+|not\s+the\s+same)\b/i;

/** The source ruling an alternative out in its own words. */
const RULES_OUT = /(?:,\s*not\s+|\binstead\s+of\s+|\brather\s+than\s+)([^.;:]{2,60})/gi;

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
  const supported = isSupported(claim, lines, terms);

  if (!supported) {
    // 1. A trap the subject's author already wrote down. Three ways out of it,
    //    all of them the same question: is the learner making this mistake, or
    //    naming it? The claim must read more like the mistake than like the
    //    correction, and it must not flip the trap's own polarity.
    const scoped = course.traps.filter((t) => t.conceptId === conceptId);
    const pool = conceptId ? scoped : course.traps;
    for (const trap of pool) {
      if (overlapRatio(claim, trap.statement) < 0.6) continue;
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
  // have no authored correction to compare against, so a claim carrying any
  // denial is left for the honest "I could not check that" reply.
  const asserting = !supported && !NEGATED.test(claim);

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

    // 3. The source rules the claim out in its own words: "…, not X",
    //    "instead of X", "rather than X". The author already did the work.
    for (const l of near) {
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
    for (const l of near) {
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
          if (!src || src.verb !== said.verb || src.prep !== said.prep) continue;
          // Same subject being talked about, different destination.
          if (disjoint(src.head, said.head)) continue;
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
 * The reply a checked claim earns: what the source says, the line that shows
 * it, and a question. A correction with no question is a lecture, so when the
 * subject has no bank question for that concept the probe is generic rather
 * than absent.
 */
const FALLBACK_PROBE = "What would you change in your sentence so it matches that line?";

export function composeClaimReply(check: ClaimCheck, conceptName: string | null): string {
  const parts: string[] = [];
  if (check.lead) parts.push(check.lead);
  if (check.quote) parts.push(`The passage says: “${check.quote.slice(0, 220)}”`);
  if (check.question) parts.push(check.question);
  else if (check.status === "contradicted") parts.push(FALLBACK_PROBE);
  if (parts.length === 0) {
    parts.push(
      `That is your position on ${conceptName ?? "this"} — let's test it rather than file it.`,
      "Say it back with the reason attached and I will check it line by line."
    );
  }
  return parts.join(" ");
}
