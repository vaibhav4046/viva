import { getCourse } from "./courses";
import type { ConceptDef } from "./courses/types";
import type { LearningIntent } from "./types";

export type CompileDraft = {
  intent: LearningIntent;
  conceptIds: string[];
  primaryConceptId: string | null;
  importance: number;
  confusion: number;
  confidenceSelfReport: number | null;
  requestedAction: "store" | "explain" | "quiz" | "compare" | "review" | "evaluate" | "none";
  interpretationConfidence: number;
  cleanedTranscript: string;
};

const NEGATION = /\b(not|n't|never|no\b|isn't|aren't|don't|doesn't)\b/i;

/**
 * Which concepts a piece of text is about, most-mentioned first.
 *
 * Ranked by how much of the sentence each concept's own words cover, not by
 * the single longest alias that appears anywhere in it. Length alone filed a
 * passage that says query, key and value six times under Self-attention,
 * because "attention" (9 characters) is longer than "query" (5) — so a paste
 * the tutor had just refused to credit still marked a concept the student
 * never mentioned as seen. Length is not evidence of what a sentence is about.
 *
 * It is still evidence of which concept owns a word, so where two concepts
 * claim the same characters the longer phrase takes them: "semantic encoding"
 * keeps its own mention instead of donating it to "encoding", and a narrow
 * concept is never outvoted by the broad one whose name it contains. That
 * rule is the whole difference between this and plain occurrence counting,
 * and it is worth 31 rows.
 *
 * Measured over every labelled text in all 26 shipped subjects — exam
 * questions, trap statements and their corrections, both explainer voices and
 * every concept description, 856 rows with a known concept:
 *
 *   longest matched alias (was)                 393 / 856
 *   occurrences, ties broken by length          376 / 856  (20 fixed, 37 broken)
 *   matched characters, longest phrase wins     407 / 856  (21 fixed,  7 broken)
 *
 * The seven it breaks are all one shape: a definition of a narrow term written
 * almost entirely in the broad term's vocabulary ("Specific heat is the amount
 * of heat required to raise the temperature…"). No lexical rule separates
 * those; a model pass over the same text would.
 */
function findConcepts(text: string, concepts: ConceptDef[]): string[] {
  const t = text.toLowerCase();
  const spans: { id: string; start: number; end: number; len: number }[] = [];
  for (const c of concepts) {
    for (const n of new Set([c.name.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())])) {
      if (n.length <= 2) continue;
      for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) {
        spans.push({ id: c.id, start: i, end: i + n.length, len: n.length });
      }
    }
  }
  // Longest first, so the phrase that wins a contested stretch of text is the
  // most specific one; earliest first where two are the same length.
  spans.sort((a, b) => b.len - a.len || a.start - b.start);
  const taken: { start: number; end: number }[] = [];
  const score = new Map<string, { chars: number; best: number }>();
  for (const s of spans) {
    if (taken.some((x) => s.start < x.end && s.end > x.start)) continue;
    taken.push(s);
    const cur = score.get(s.id) ?? { chars: 0, best: 0 };
    score.set(s.id, { chars: cur.chars + s.len, best: Math.max(cur.best, s.len) });
  }
  return [...score]
    .sort((a, b) => b[1].chars - a[1].chars || b[1].best - a[1].best)
    .map(([id]) => id);
}

/** Cleanup: trim fillers but NEVER drop negation, numbers, names, technical terms. */
export function cleanTranscript(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  // Remove leading fillers only; keep everything else verbatim.
  s = s.replace(/^(um+|uh+|like|so|well|okay|ok)[,\s]+/i, "");
  s = s.replace(/\b(um+|uh+)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  if (s.length > 0) s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.?!]$/.test(s)) s += ".";
  return s;
}

/**
 * HARNESS A — Semantic Compiler. Deterministic, rule-based; LLM-free so the
 * golden demo path cannot randomly fail. An LLM may re-rank later, but the
 * persisted event always validates against the schema.
 */
export function compileTranscript(
  raw: string,
  opts: {
    selection?: string;
    hasActiveSource?: boolean;
    /** The subject's own concepts. Falls back to a starter's when absent. */
    concepts?: ConceptDef[];
    courseId?: string | null;
  } = {}
): CompileDraft {
  const cleanedTranscript = cleanTranscript(raw);
  const t = raw.toLowerCase();
  const conceptIds = findConcepts(raw + " " + (opts.selection ?? ""), opts.concepts ?? getCourse(opts.courseId).concepts);
  const primaryConceptId = conceptIds[0] ?? null;

  const has = (...res: RegExp[]) => res.some((r) => r.test(t));
  let intent: LearningIntent = "note";
  let requestedAction: CompileDraft["requestedAction"] = "none";
  let importance = 0.4;
  let confusion = 0.1;
  let confidence = 0.72;

  if (has(/quiz me|test me|ask me|flashcard|drill me/)) {
    intent = "quiz_request";
    requestedAction = "quiz";
    importance = 0.7; confusion = 0.3; confidence = 0.9;
  } else if (has(/oral exam|enter viva|viva exam|mock exam|practice exam/)) {
    intent = "quiz_request"; requestedAction = "quiz"; importance = 0.85; confusion = 0.3; confidence = 0.88;
  } else if (has(/teach (it|this|me)|explain it back|let me explain|i'll explain|i will explain/)) {
    intent = "teachback"; requestedAction = "evaluate"; importance = 0.75; confusion = 0.2; confidence = 0.85;
  } else if (has(/i think|i believe|in my view|probably|my answer is|it means|because/)) {
    // Claim beats confusion: "I think X" is a belief to check, even if uncertain.
    intent = "claim"; requestedAction = "evaluate"; importance = 0.65; confusion = 0.35; confidence = 0.8;
    // Spoken and written forms of the same admission: "don't get it",
    // "do not understand", "can't follow". Dictation returns the long form.
  } else if (has(/(?:do\s?n['’]?t|do not|cannot|can['’]?t|can not)\s+(?:really\s+)?(?:understand|get|follow|see)|confused|confusing|no idea|lost|what does .*mean|unclear|struggling/)) {
    intent = "confusion"; requestedAction = "explain"; importance = 0.7; confusion = 0.9; confidence = 0.88;
  } else if (has(/remember this|remember it|don't forget|save this|important|exam important|might be on the exam|mark this/)) {
    intent = has(/exam/) ? "exam_marker" : "remember";
    requestedAction = "store"; importance = 0.9; confusion = 0.15; confidence = 0.9;
  } else if (has(/\b(hint|clue|nudge)\b|i'?m stuck|im stuck|\bstuck\b|give me a start|help me out|i give up|no idea where to start/)) {
    // A process turn, not a position: it must not be filed against a passage
    // and it must not cost the learner anything for admitting they are stuck.
    intent = "hint"; requestedAction = "none"; importance = 0.5; confusion = 0.7; confidence = 0.85;
  } else if (has(/come back|tomorrow|later|review|revise|spaced/)) {
    intent = "review_request"; requestedAction = "review"; importance = 0.75; confusion = 0.2; confidence = 0.85;
  } else if (has(/compare|versus|vs\.? |difference between|different from|similar to/)) {
    intent = "compare"; requestedAction = "compare"; importance = 0.65; confusion = 0.4; confidence = 0.82;
  } else if (has(/explain|eli5|without jargon|simply|simple terms|clarify/)) {
    intent = "explain"; requestedAction = "explain"; importance = 0.6; confusion = 0.5; confidence = 0.84;
  } else if (has(/\?$/) || has(/^is |^are |^does |^do |^can |^why |^what |^how |^when /)) {
    intent = "question"; requestedAction = "explain"; importance = 0.55; confusion = 0.45; confidence = 0.78;
  } else if (has(/actually|correction|i meant|sorry,? i mean/)) {
    intent = "correction"; requestedAction = "store"; importance = 0.6; confusion = 0.3; confidence = 0.75;
  } else if (has(/connect|relates to|reminds me|like .* in /)) {
    intent = "connection"; requestedAction = "store"; importance = 0.6; confusion = 0.2; confidence = 0.7;
  }

  // "Explain X without jargon" keeps explain intent but flags style downstream.
  // Negation present -> never collapse into a positive remember.
  if (NEGATION.test(t) && intent === "remember") {
    intent = "claim";
    requestedAction = "evaluate";
    confidence = 0.7;
  }
  if (conceptIds.length === 0) confidence = Math.min(confidence, 0.55);

  return {
    intent, conceptIds, primaryConceptId, importance, confusion,
    confidenceSelfReport: null, requestedAction,
    interpretationConfidence: Math.round(confidence * 100) / 100,
    cleanedTranscript,
  };
}
