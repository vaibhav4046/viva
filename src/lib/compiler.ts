import { getCourse } from "./courses";
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

function findConcepts(text: string, courseId?: string | null): string[] {
  const t = text.toLowerCase();
  const scored: { id: string; best: number }[] = [];
  for (const c of getCourse(courseId).concepts) {
    const names = [c.name.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
    let best = 0;
    for (const n of names) {
      if (n.length > 2 && t.includes(n) && n.length > best) best = n.length;
    }
    if (best > 0) scored.push({ id: c.id, best });
  }
  // Most specific (longest matched alias) first: "positional encoding" beats "attention".
  scored.sort((a, b) => b.best - a.best);
  return scored.map((s) => s.id);
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
  opts: { selection?: string; hasActiveSource?: boolean; courseId?: string | null } = {}
): CompileDraft {
  const cleanedTranscript = cleanTranscript(raw);
  const t = raw.toLowerCase();
  const conceptIds = findConcepts(raw + " " + (opts.selection ?? ""), opts.courseId);
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
  } else if (has(/don't understand|dont understand|don't get|confused|confusing|no idea|lost|what does .*mean|unclear|struggling/)) {
    intent = "confusion"; requestedAction = "explain"; importance = 0.7; confusion = 0.9; confidence = 0.88;
  } else if (has(/remember this|remember it|don't forget|save this|important|exam important|might be on the exam|mark this/)) {
    intent = has(/exam/) ? "exam_marker" : "remember";
    requestedAction = "store"; importance = 0.9; confusion = 0.15; confidence = 0.9;
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
