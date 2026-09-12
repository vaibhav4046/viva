import { getCourse, DEFAULT_COURSE_ID } from "../courses";
import type { Course } from "../courses/types";
import { scoreChunks, verifyEvidence } from "../retrieval";
import type { SourceChunk } from "../types";

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
 * HARNESS D (exam/teachback branch) — claim assessment against retrieved
 * evidence. Keyword-coverage rubric, deterministic. No invented citations:
 * evidenceIds always resolve to real chunk ids. The question bank and the
 * chunk pool both come from the requested course (default: Transformers).
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

  // Classic "importance" misconception only applies where the rubric expects
  // order: answering "importance" when the source demands "order".
  if (
    q.requiredKeywords.includes("order") &&
    /important|relevance|relevant|which words matter/.test(low) &&
    !/order|position|sequence|permut/.test(low)
  ) {
    return {
      verdict: "incorrect",
      correctPoints: ["You recognised attention compares tokens."],
      missingPoints: ["Without position information the model loses sequence order."],
      possibleMisconception: "Attention weights already encode importance — what is lost without position is order, not importance (see the positional information section).",
      feedback:
        "Good instinct — attention does compare tokens. But the missing piece is sequence order: without positional information the model cannot tell first from last. Try that distinction again.",
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
    };
  }

  const hits = affirmedHits(answerTranscript, q.requiredKeywords);
  const misses = q.requiredKeywords.filter((k) => !hits.includes(k));
  const ratio = hits.length / q.requiredKeywords.length;
  if (ratio >= 0.66) {
    return {
      verdict: "correct",
      correctPoints: [`Mentioned: ${hits.join(", ")}.`],
      missingPoints: [],
      possibleMisconception: null,
      feedback: "Correct — that covers the distinction the source draws.",
      evidenceIds: verdict.support.length > 0 ? verdict.support : chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
    };
  }
  if (ratio > 0) {
    return {
      verdict: "partial",
      correctPoints: [`You have part of it: ${hits.join(", ")}.`],
      // The remaining points are the marking key. They are named only once the
      // question is closed — see `fullAnswerCovers` and `sealAnswerKey`.
      missingPoints: [`There is ${misses.length === 1 ? "one piece" : `${misses.length} pieces`} still missing.`],
      possibleMisconception: null,
      feedback: `Partly there. ${q.hint}`,
      evidenceIds: chunks.map((c) => c.id),
      fullAnswerCovers: q.requiredKeywords,
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
    // the "nothing caught" case, and it still asks rather than files.
    const q = course.examQuestions.find((x) => x.conceptId === opts.conceptId);
    return {
      text: q
        ? `That is your position on ${label}. Nothing in the passage contradicts it, so let's test whether it holds: ${q.question}`
        : `That is your position on ${label}. Say it once more with the reason attached and I will check it line by line.`,
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
