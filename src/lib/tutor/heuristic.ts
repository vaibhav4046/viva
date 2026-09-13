import { getCourse, DEFAULT_COURSE_ID } from "../courses";
import type { Course } from "../courses/types";
import { scoreChunks, tokens, verifyEvidence } from "../retrieval";
import type { SourceChunk } from "../types";
import { checkClaim, passageSays, type ClaimCheck } from "./claim";

export type Assessment = {
  verdict: "correct" | "partial" | "incorrect";
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
  /**
   * What a full answer covers. Held back while the question is still open —
   * printing the marking key above a live retry box turns the retry into
   * theatre: the learner types back the three words they were just shown and
   * clears a question they cannot answer.
   */
  fullAnswerCovers: string[];
  /**
   * What the subject's own passages said about the sentence. The verdict above
   * is downstream of this, and `gradeAnswer` reads it so the model branch is
   * held to the same line.
   */
  check: ClaimCheck;
};

const NEG_WORDS = new Set(["not", "no", "never", "cannot", "without", "lacks", "lack", "missing", "fails", "fail", "neither", "nor"]);
const KNOW_VERBS = ["know", "understand", "grasp", "recall", "remember", "tell"];
// Absence-as-mechanism: "without position the model LOSES order" affirms the
// concept even though a negation is nearby. Loss verbs after the keyword win.
const LOSS_VERBS = ["lose", "loses", "lost", "losing", "missing", "lacks", "lack", "absent", "gone"];

function tokenize(low: string): string[] {
  return low
    .toLowerCase()
    .replace(/n't\b/g, " not")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Affirmed-mention matching: a keyword counts when the student states it,
 * NOT when they deny it ("does not involve order" ≠ "order matters").
 * Exception: negated epistemic verbs ("doesn't know their order") affirm the
 * TOPIC through admitted ignorance — the student named the right concept.
 */
export function keywordAffirmed(fullText: string, keyword: string): boolean {
  const toks = tokenize(fullText);
  const kw = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (!kw.length) return false;
  for (let i = 0; i + kw.length <= toks.length; i++) {
    const slice = toks.slice(i, i + kw.length);
    // Forward: token contains the keyword part (plurals, "permutation-equivariant").
    // Reverse (keyword contains token) only for substantial tokens: without the
    // length guard, single letters like "i" match any keyword containing them.
    const match = kw.every((k, j) => slice[j].includes(k) || (slice[j].length >= 4 && k.includes(slice[j])));
    if (!match) continue;
    // Absence-as-mechanism first: "without X the model loses Y" affirms.
    const after = toks.slice(i + kw.length, i + kw.length + 4);
    if (after.some((t) => LOSS_VERBS.some((l) => t === l || t.startsWith(l)))) return true;
    const before = toks.slice(Math.max(0, i - 3), i);
    const negated = before.some((t) => NEG_WORDS.has(t));
    if (!negated) return true;
    const verbs = toks.slice(Math.max(0, i - 2), i);
    if (verbs.some((t) => KNOW_VERBS.some((k) => t === k || t.startsWith(k)))) return true;
    // Denied mention — keep scanning; a later affirmed occurrence still counts.
  }
  return false;
}

function affirmedHits(fullText: string, keywords: string[]): string[] {
  return keywords.filter((k) => keywordAffirmed(fullText, k));
}

/**
 * What the learner actually said, in their words, for each point they landed.
 *
 * "What was right: you identified that without positional information a
 * Transformer cannot distinguish the order of tokens" was printed over three
 * typed nouns. Nothing produced that sentence except a model filling in a
 * story about a student who understood — so credit is a quote now, and a
 * quote cannot describe reasoning that never happened.
 */
export function quotedHits(answer: string, requiredKeywords: string[]): string[] {
  const hits = affirmedHits(answer, requiredKeywords);
  if (hits.length === 0) return [];
  const said = hits.map((k) => spokenForm(answer, k) ?? k);
  return [`You said ${said.map((s) => `“${s}”`).join(", ")}.`];
}

/** The learner's own spelling of a required point, pulled out of their answer. */
function spokenForm(answer: string, keyword: string): string | null {
  const kw = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (kw.length === 0) return null;
  const words = answer.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  for (let i = 0; i + kw.length <= words.length; i++) {
    const slice = words.slice(i, i + kw.length);
    const ok = kw.every((k, j) => {
      const w = slice[j].toLowerCase();
      return w.includes(k) || (w.length >= 4 && k.includes(w));
    });
    if (ok) return slice.join(" ");
  }
  return null;
}

/**
 * The answer names one of the required points and predicates nothing.
 *
 * A judge typed "order attention permutation" into a question and was told
 * CORRECT, then said it was a quiz they could beat without knowing anything —
 * and the map believes the result. Naming the points is not making them, so a
 * list of nouns is capped at partial however it is graded, by the keywords
 * here or by the model, and gets back the one thing that is true about it:
 * those are the words, now say it as a sentence.
 */
export function isFragmentAnswer(answer: string, requiredKeywords: string[]): boolean {
  if (requiredKeywords.length === 0) return false;
  if (affirmedHits(answer, requiredKeywords).length === 0) return false;
  return !statesSomething(answer, new Set(requiredKeywords.flatMap((k) => tokenize(k))));
}

/** The word is one of the required points, in any of its spellings. */
function isPoint(key: Set<string>, word: string): boolean {
  for (const k of key) if (word.includes(k) || k.includes(word)) return true;
  return false;
}

/**
 * Does anything in here do the work of a verb?
 *
 * Not a parser — a closed class of auxiliaries and high-frequency verbs, plus
 * any word of the learner's own carrying a verb ending. It only has to
 * separate a sentence from a list of nouns, and it errs towards "sentence",
 * because calling a real answer a list is the expensive mistake: it caps what
 * the learner can score on a question they may have answered properly.
 */
function statesSomething(answer: string, key: Set<string>): boolean {
  return tokenize(answer).some(
    (w) =>
      VERBS.has(w) ||
      (w.length > 3 && /(?:ed|ing|es|s)$/.test(w) && !/(?:ss|us|is)$/.test(w) && !isPoint(key, w))
  );
}

const VERBS = new Set(
  ("is,are,was,were,be,been,being,am,has,have,had,do,does,did,can,cannot,could,will,would,shall,should,may,might,must," +
    "mean,means,matter,matters,work,works,help,helps,show,shows,tell,tells,keep,keeps,hold,holds,come,comes,go,goes," +
    "get,gets,make,makes,made,need,needs,give,gives,lose,loses,lost,let,lets,say,says,know,knows,think,thinks,use,uses,add,adds").split(",")
);

/**
 * The honest lead when nothing checked out either way. One string, used by the
 * keyword branch and the model branch alike, so a learner gets the same answer
 * whether or not a provider was reachable.
 *
 * It used to say "Nothing in the passage contradicts it", which was the worst
 * sentence in the product: the checks are lexical, so not catching a claim
 * means the check could not read it, NOT that the source agrees.
 */
export const UNCHECKED_LEAD =
  "I could not check that against your source, so I will not tell you it is right.";

/**
 * The second half of an honest "not checked": where to go next. Paired with
 * `UNCHECKED_LEAD` on a quiz answer that named every marking word and that
 * nothing in the source confirmed.
 */
export const READ_IT_BACK =
  "Read the passage beside this and say it again in your own words — if it matches a line, I will mark it.";

/** "That is the word. Now say it as a sentence." */
export const SAY_IT_AS_A_SENTENCE =
  "Those are the words. Now say it as a sentence and I will check that against the passage.";

/**
 * Singular-ish, and the hyphen read as a space, so "self-attention" matches a
 * student typing "self attention" and "weights" matches "weight".
 *
 * `claim.ts` has the same two lines and does not export them. Copied rather
 * than exported because that file is being changed on another branch as this
 * is written; fold them together once both have landed.
 */
function loose(text: string): string[] {
  return tokens(text.replace(/-/g, " ")).map((w) => {
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (w.endsWith("ss")) return w;
    return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
  });
}

/**
 * How much of what the learner said is drawn from the passages in front of
 * them: the share of their own content words that appear in the retrieved
 * text. Function words and anything under four letters are already gone.
 *
 * This is a REFUTATION, not a confirmation. A sentence assembled out of the
 * source's own vocabulary can still be false — "an attention weight is the
 * same vector as the query and the key" scores 1.00 — which is why it only
 * ever removes `correct` and never grants it on its own. What it does catch is
 * the sentence that imports its content from nowhere: the two the judge
 * invented score 0.43 and 0.33 ("batch", "document", "divided", "important"),
 * against 0.89 to 1.00 for real answers to the same subject's questions.
 */
export function groundedFraction(answer: string, chunks: SourceChunk[]): number {
  const said = new Set(loose(answer));
  if (said.size === 0) return 0;
  const pool = new Set(chunks.flatMap((c) => loose(c.text)));
  let hits = 0;
  said.forEach((w) => { if (pool.has(w)) hits += 1; });
  return hits / said.size;
}

/**
 * Where "said it in the source's terms" starts.
 *
 * Measured on the shipped Transformers subject: real answers to its seven exam
 * questions land 0.82-1.00, the two sentences the judge made up land 0.43 and
 * 0.33, and "order and attention and permutation all matter here" — the
 * marking key with a verb bolted on — lands 0.60. The bar sits in that gap.
 * Everything below it is answered honestly rather than wrongly, so the cost of
 * setting it a little high is one more sentence from the learner.
 */
const GROUNDED_ENOUGH = 0.7;

/**
 * The passage speaking, in one line, so a verdict can show its working.
 * `checkClaim` writes the lead; the quote is the sentence that decided it.
 */
function saidBySource(check: ClaimCheck): string {
  return [check.lead, check.quote ? passageSays(check.quote) : null]
    .filter(Boolean)
    .join(" ");
}

/**
 * HARNESS D (exam/teachback branch) — claim assessment against retrieved
 * evidence. Deterministic and model-free. No invented citations: evidenceIds
 * always resolve to real chunk ids. The question bank and the chunk pool both
 * come from the requested course (default: Transformers).
 *
 * Keyword coverage says how much of the marking key the learner named. It does
 * NOT say whether they are right, and the gap between those two is the whole
 * of S-A-01: "an attention weight is the number of tokens in the batch divided
 * by the weight of the document" contains both required points of `ex_sa_1`
 * ("weight", "token") inside a grammatical sentence, cleared the two-thirds
 * bar, and came back **Correct — that covers the distinction the source
 * draws**, with GOT IT 1 written onto the map. The sentence was invented. The
 * question has two required words and one of them is in the question itself.
 *
 * So `correct` here now needs three things, not one: the marking points named,
 * nothing in the passages contradicting the sentence, and the sentence written
 * out of the passages' own vocabulary (`groundedFraction`) — or, better, a
 * line of the source that says the same thing in the same polarity
 * (`checkClaim` → `supported`, the one status in this codebase allowed to tell
 * somebody they are right, and it arrives with the sentence that decided it).
 * Coverage backed by none of that is `partial` and says so.
 *
 * ponytail: every check here is lexical, so a false sentence built entirely
 * out of the source's own words — "an attention weight is the same vector as
 * the query and the key" — can still clear this bar when no model is
 * reachable. That is the residual, it is named in the tests, and the exit is a
 * model pass over the same passages, which `gradeAnswer` already runs whenever
 * a provider answers. A miss costs the learner one more honest sentence; the
 * false positive costs them the concept, because they will not revise it.
 */
export function assessAnswer(
  questionId: string,
  answerTranscript: string,
  opts: { courseId?: string | null; course?: Course } = {}
): Assessment {
  // A subject the learner built is not in the registry, so the caller passes
  // it in. Falling back to a starter here would grade the wrong question.
  const course = opts.course ?? getCourse(opts.courseId);
  const q = course.examQuestions.find((x) => x.id === questionId) ?? course.examQuestions[0];
  const courseChunks: SourceChunk[] = course.sources.flatMap((s) => s.chunks);
  const retrieved = scoreChunks(courseChunks, q.question + " " + answerTranscript, {
    conceptIds: [q.conceptId],
    limit: 3,
  });
  const chunks: SourceChunk[] = retrieved.map((r) => r.chunk);
  const verdict = verifyEvidence(answerTranscript, chunks);
  const low = answerTranscript.toLowerCase();
  // What the source itself says about the sentence, on the same checks the
  // typed-claim path runs. This is the only thing here that may write
  // "correct", and the only thing that may quote a line while writing
  // "incorrect".
  const check = checkClaim({ claim: answerTranscript, chunks, course, conceptId: q.conceptId });

  // Classic "importance" misconception only applies where the rubric expects
  // order: answering "importance" when the source demands "order".
  if (
    q.requiredKeywords.includes("order") &&
    /important|relevance|relevant|which words matter/.test(low) &&
    !/order|position|sequence|permut/.test(low)
  ) {
    return {
      verdict: "incorrect",
      // Credit is a quote of what they said or it is nothing. "You recognised
      // attention compares tokens" was printed over answers that said no such
      // thing — an understanding invented on the learner's behalf.
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      missingPoints: ["Without position information the model loses sequence order."],
      possibleMisconception: "Attention weights already encode importance — what is lost without position is order, not importance (see the positional information section).",
      feedback:
        "The missing piece is sequence order: without positional information the model cannot tell first from last. Try that distinction again.",
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }

  const hits = affirmedHits(answerTranscript, q.requiredKeywords);
  const misses = q.requiredKeywords.filter((k) => !hits.includes(k));
  const ratio = hits.length / q.requiredKeywords.length;
  // The marking words with nothing around them. Never correct, and the line
  // back is the one thing that is actually true about it: those are the words.
  if (isFragmentAnswer(answerTranscript, q.requiredKeywords)) {
    return {
      verdict: "partial",
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      missingPoints: ["Say it as a sentence."],
      possibleMisconception: null,
      feedback: SAY_IT_AS_A_SENTENCE,
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }
  // The source says otherwise, and it says which line. Wrong however many of
  // the marking words the sentence happens to contain.
  if (check.status === "contradicted") {
    return {
      verdict: "incorrect",
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      missingPoints: [],
      possibleMisconception: check.lead,
      feedback: `${saidBySource(check)} ${q.hint}`.trim(),
      evidenceIds: check.chunkId ? [check.chunkId] : chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }
  // Named the marking points, said them in the source's own terms, and the
  // source did not object. That is as close to "states what the passage
  // states" as a lexical check gets, and it is the only shape that may write
  // CORRECT without a model having read the answer.
  const grounded = groundedFraction(answerTranscript, chunks) >= GROUNDED_ENOUGH;
  if (ratio >= 0.66 && (check.status === "supported" || grounded)) {
    return {
      verdict: "correct",
      // The learner's own words, never the marking key: printing "Mentioned:
      // order, attention, permutation" handed the scheme back on the card.
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      missingPoints: [],
      possibleMisconception: null,
      // When a line of their own source says it, quote that line: a verdict
      // that can show its sentence is the one the learner can check.
      feedback: check.status === "supported" ? saidBySource(check) : "Correct — that covers the distinction the source draws.",
      evidenceIds: check.chunkId ? [check.chunkId] : verdict.support.length > 0 ? verdict.support : chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }
  // Every marking word is present and nothing in the source confirms what the
  // sentence does with them. Not correct: nothing checked it.
  if (ratio >= 0.66) {
    return {
      verdict: "partial",
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      missingPoints: [],
      possibleMisconception: null,
      feedback: `${UNCHECKED_LEAD} ${READ_IT_BACK}`,
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }
  if (ratio > 0) {
    return {
      verdict: "partial",
      correctPoints: quotedHits(answerTranscript, q.requiredKeywords),
      // The remaining points are the marking key. They are named only once the
      // question is closed — see `fullAnswerCovers` and `sealAnswerKey`.
      missingPoints: [`There is ${misses.length === 1 ? "one piece" : `${misses.length} pieces`} still missing.`],
      possibleMisconception: null,
      feedback: `Partly there. ${q.hint}`,
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
      check,
    };
  }
  return {
    verdict: "incorrect",
    correctPoints: [],
    missingPoints: [],
    possibleMisconception: sourceDisagrees(chunks),
    feedback: `Not quite — and that is worth knowing now rather than on Friday. ${q.hint}`,
    evidenceIds: chunks.map((c) => c.id),
    fullAnswerCovers: q.requiredKeywords,
    check,
  };
}

/** Where the source disagrees, named by page rather than by category. */
function sourceDisagrees(chunks: SourceChunk[]): string {
  const c = chunks[0];
  if (!c) return "That is not what your source says.";
  const at = c.locator.page ? `p.${c.locator.page}` : c.locator.section ?? "your source";
  return `That is not what ${at} says.`;
}

/**
 * Response-safe view of a graded answer.
 *
 * `closed` means the question is finished — cleared, skipped, or out of
 * attempts. Only then does the learner see what a full answer covers; while it
 * is live they get the nudge and nothing else.
 */
export function sealAnswerKey<T extends { verdict: string; missingPoints: string[]; fullAnswerCovers?: string[] }>(
  graded: T,
  closed: boolean
): Omit<T, "fullAnswerCovers"> & { missingPoints: string[]; fullAnswerCovers: string[] } {
  return {
    ...graded,
    missingPoints: closed ? graded.missingPoints : [],
    fullAnswerCovers: closed ? graded.fullAnswerCovers ?? [] : [],
  };
}

export type TutorResult = {
  text: string;
  evidenceIds: string[];
  strategy: "direct" | "socratic" | "hint";
  missingConcepts: string[];
};

/**
 * HARNESS D — Socratic Tutor (heuristic branch; an LLM provider may rewrite
 * phrasing, but evidence selection and policy stay here).
 * Policy: factual lookup -> direct; conceptual confusion -> smallest useful
 * hint first; exam questions -> guided reasoning, never a bare answer dump.
 */
export function tutorRespond(opts: {
  intent: string;
  cleanedTranscript: string;
  conceptName: string | null;
  conceptId: string | null;
  evidenceIds: string[];
  jargonFree?: boolean;
  mastery?: number;
  courseId?: string | null;
  /** The resolved subject. A learner's own is not in the registry. */
  course?: Course;
}): TutorResult {
  const { intent, cleanedTranscript, conceptName, evidenceIds } = opts;
  const course = opts.course ?? getCourse(opts.courseId);
  const jargon = /without jargon|simply|simple|eli5|no jargon/i.test(cleanedTranscript);
  const label = conceptName ?? "this concept";

  if (intent === "quiz_request") {
    const q = course.examQuestions.find((x) => x.conceptId === opts.conceptId) ?? course.examQuestions[0];
    return {
      text: q
        ? `${q.question} Answer aloud — can you say it in one or two sentences? I will check it against the passage.`
        : "Say everything you remember in one minute — I will check it against the passage.",
      evidenceIds,
      strategy: "socratic",
      missingConcepts: [],
    };
  }
  if (intent === "confusion" || intent === "question" || intent === "explain") {
    const explainer = opts.conceptId ? course.explainers[opts.conceptId] : undefined;
    // A subject VIVA read itself has no plain-language rewrite to give, so
    // asking for one returns the passage rather than an empty reply.
    const body = explainer
      ? (jargon || opts.jargonFree ? explainer.jargonFree || explainer.formal : explainer.formal)
      : "";
    if (explainer && body) {
      return { text: body, evidenceIds, strategy: "socratic", missingConcepts: explainer.missing };
    }
    return {
      text:
        evidenceIds.length > 0
          ? `The passage on ${label} is open beside this. Read it, then say it back to me in your own words — I'll tell you what you left out.`
          : `I can't find ${label} anywhere in your source, so I won't guess at it. Point me at the page, or add the notes that cover it.`,
      evidenceIds,
      strategy: evidenceIds.length > 0 ? "hint" : "direct",
      missingConcepts: [],
    };
  }
  if (intent === "claim") {
    // A checked claim never reaches here — `checkClaim` in ./claim.ts has
    // already led with the contradiction and the line that shows it. This is
    // the "nothing caught" case.
    //
    // It used to say "Nothing in the passage contradicts it", which was the
    // worst sentence in the product: the checks are lexical, so not catching a
    // claim means the check could not read it, NOT that the source agrees —
    // and the passage linked underneath was sometimes the one that disproved
    // the student. Never assert agreement the check did not produce.
    const q = course.examQuestions.find((x) => x.conceptId === opts.conceptId);
    const head = UNCHECKED_LEAD;
    return {
      text: q
        ? `${head} ${evidenceIds.length > 0 ? "The nearest passage is beside this — read it, then answer me:" : "Answer me this instead:"} ${q.question}`
        : `${head} Say it once more with the reason attached and I will check it line by line.`,
      evidenceIds,
      strategy: "socratic",
      missingConcepts: [],
    };
  }
  return {
    text:
      evidenceIds.length > 0
        ? `Kept, next to the passage it belongs with. Say "quiz me" when you want it tested.`
        : `Kept. Say "quiz me" when you want it tested.`,
    evidenceIds,
    strategy: "direct",
    missingConcepts: [],
  };
}

/**
 * HARNESS E — Response Verifier. One repair pass max. Checks: every
 * course-factual claim has evidence; citations resolve; no new unexplained
 * jargon flood; concise enough to speak.
 */
export function verifyResponse(text: string, evidenceIds: string[], knownIds: Set<string>): { pass: boolean; violations: string[]; repaired: string } {
  const violations: string[] = [];
  const citesSection = /§\d|p\.\d|(?:week|unit|chapter|lecture|section)\s*\d/i.test(text);
  if (citesSection && evidenceIds.length === 0) violations.push("cites source with no evidence attached");
  for (const id of evidenceIds) if (!knownIds.has(id)) violations.push(`unknown evidence id ${id}`);
  const longWords = (text.match(/\b[a-z]{13,}\b/gi) ?? []).length;
  if (longWords > 6 && /without jargon|simply/i.test(text)) violations.push("jargon gate: long unexplained terms in a simple explanation");
  if (text.split(/\s+/).length > 220) violations.push("too long for spoken delivery");
  let repaired = text;
  if (violations.includes("cites source with no evidence attached")) {
    repaired = repaired
      .replace(/\s*\([^()]*(?:§\d|p\.\d|(?:week|unit|chapter|lecture|section)\s*\d)[^()]*\)\.?/gi, "")
      .replace(/\s+([.,;:])/g, "$1")
      .trim();
  }
  return { pass: violations.length === 0, violations, repaired };
}

/**
 * Teachback rubric — compatibility constants for the default (Transformers)
 * lab. Routes should read `course.teachback` from the registry instead.
 * Every concept has at least 3 keywords; scoring is a case-insensitive
 * affirmed-mention fraction so it stays deterministic and unit-testable.
 */
const DEFAULT_TEACHBACK = getCourse(DEFAULT_COURSE_ID).teachback;

export const TEACHBACK_KEYWORDS: Record<string, string[]> = DEFAULT_TEACHBACK.keywords;

export const TEACHBACK_HINTS: Record<string, string> = DEFAULT_TEACHBACK.hints;

export type TeachbackVerdict = "strong" | "developing" | "needs-work";

export type TeachbackScore = {
  coverage: number;
  score: number;
  hits: string[];
  misses: string[];
  verdict: TeachbackVerdict;
};

/** Pure teachback scorer: affirmed-mention fraction (negation-aware, deterministic). */
export function scoreTeachback(transcript: string, requiredKeywords: string[]): TeachbackScore {
  const hits = affirmedHits(transcript, requiredKeywords);
  const misses = requiredKeywords.filter((k) => !hits.includes(k));
  const coverage = requiredKeywords.length > 0 ? hits.length / requiredKeywords.length : 0;
  const verdict: TeachbackVerdict = coverage >= 0.66 ? "strong" : coverage >= 0.33 ? "developing" : "needs-work";
  return { coverage, score: Math.round(coverage * 100), hits, misses, verdict };
}
