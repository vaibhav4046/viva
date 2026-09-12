import type { Course, ExamQuestion } from "@/lib/courses";
import { tokens } from "@/lib/retrieval";
import type { SourceChunk } from "@/lib/types";

/**
 * Checking a stated belief against the source.
 *
 * The landing page promises VIVA catches what you got wrong. Until now a
 * claim was filed, not checked: "positional encoding is added to the attention
 * weights after the softmax" came back as "stored as your current belief",
 * which is a note app with extra steps — and worse, it left the wrong sentence
 * sitting in the student's own notes next to the passage that disproves it.
 *
 * Three deterministic checks run in order, cheapest first. None of them
 * involves a model, so the answer is the same every time and a wrong belief is
 * caught whether or not a provider is configured:
 *
 *   1. a known trap the subject ships (the author already wrote why it is
 *      wrong and what the right answer is);
 *   2. a relation mismatch — the claim says X is <done> to Y, the source says
 *      X is <done> to Z, and Y and Z share nothing;
 *   3. nothing in the passages goes anywhere near it, so VIVA says so rather
 *      than guessing.
 *
 * Anything else comes back `consistent`, which means "not caught", not
 * "verified" — the reply asks a question instead of blessing the sentence.
 *
 * ponytail: checks 1 and 2 are lexical, so a claim phrased entirely in the
 * student's own words can slip past. That is the honest failure direction — a
 * miss asks a question, it never asserts a false correction. A model pass over
 * the same passages is the upgrade if precision ever needs to go higher.
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

const NEGATED = /\b(not|never|isn['’]?t|aren['’]?t|does\s?n['’]?t|do\s?n['’]?t|wrong|false|myth|misconception)\b/i;

/** Sentence split that keeps abbreviations like "p.11" and "e.g." intact. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function contentTokens(s: string): Set<string> {
  return new Set(tokens(s));
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

  // 1. A trap the subject's author already wrote down. Skipped when the
  //    learner is denying the trap rather than repeating it.
  if (!NEGATED.test(claim)) {
    const scoped = conceptId ? course.traps.filter((t) => t.conceptId === conceptId) : course.traps;
    const pool = scoped.length > 0 ? scoped : course.traps;
    for (const trap of pool) {
      if (overlapRatio(claim, trap.statement) < 0.6) continue;
      const line = bestLine(chunks, trap.correct) ?? bestLine(chunks, trap.statement);
      return ask({
        status: "contradicted",
        lead: `Not quite — ${firstSentence(trap.whyWrong)}`,
        quote: line?.line ?? null,
        chunkId: line?.chunk.id ?? null,
      });
    }
  }

  // 2. Relation mismatch: the source puts the same thing somewhere else.
  const said = readRelation(claim);
  if (said) {
    for (const chunk of chunks) {
      for (const line of sentencesOf(chunk.text)) {
        const src = readRelation(line);
        if (!src || src.verb !== said.verb || src.prep !== said.prep) continue;
        // Same subject being talked about, different destination.
        if (disjoint(src.head, said.head)) continue;
        if (!disjoint(src.object, said.object)) continue;
        return ask({
          status: "contradicted",
          lead: `Not quite — ${where(chunk)} says ${src.head} are ${src.verb} ${src.prep} ${src.object}, not ${said.object}.`,
          quote: line,
          chunkId: chunk.id,
        });
      }
    }
  }

  // 3. Nothing in the passages is about this. Say so; do not guess.
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
        lead: "I can't find that in your source, so I won't tell you it is right.",
      });
    }
  }

  return ask({});
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
