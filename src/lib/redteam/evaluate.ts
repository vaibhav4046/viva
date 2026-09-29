import type { ClaimPart, ClaimStatus, Passage, SourceDocument, Verdict } from "./types";
import {
  HEDGE,
  NEGATION,
  NOT_YET,
  QUALIFIERS,
  clauses,
  compact,
  contentStems,
  figures,
  oppositeOf,
  sentences,
} from "./text";

/**
 * The claim engine.
 *
 * Question it answers: does THIS DOCUMENT stand behind THIS SENTENCE?
 *
 * It is a small set of rules over the document's own words, not a model, and
 * that is a choice. A verdict here is a product promise — "CONTRADICTED" is
 * shown to a person about to defend their work — so every verdict has to be
 * reproducible and has to point at passages that exist. A model may help say
 * things out loud; it does not get to decide them.
 *
 * What it can and cannot do, stated once:
 *  - It reads negation, "not yet / planned" language, opposite qualifiers
 *    (automatic vs manual), and numbers with their unit.
 *  - It does NOT understand paraphrase it has no shared words for. A claim
 *    that says the same thing in wholly different vocabulary comes back
 *    UNSUPPORTED, and UNSUPPORTED is worded as "I could not find that", never
 *    as "that is false". It errs toward saying less, not toward inventing.
 */

type Stance = "support" | "contradict" | "partial" | "none";

type Judged = { passage: Passage; stance: Stance; reason: string };

const RELEVANT_SHARE = 0.5;

/** Which of a sentence's stems sit inside a negated clause. */
function negatedStems(sentence: string): Set<string> {
  const out = new Set<string>();
  for (const c of clauses(sentence)) {
    const negated = NEGATION.test(compact(c)) || NOT_YET.test(c);
    if (!negated) continue;
    for (const s of contentStems(c)) out.add(s);
  }
  return out;
}

function assertedStems(sentence: string): Set<string> {
  const out = new Set<string>();
  for (const c of clauses(sentence)) {
    if (NEGATION.test(compact(c)) || NOT_YET.test(c)) continue;
    for (const s of contentStems(c)) out.add(s);
  }
  return out;
}

/** Judge one claim clause against one passage. */
function judge(claim: string, passage: Passage): Judged {
  const cStems = new Set(contentStems(claim));
  const pStems = new Set(contentStems(passage.text));
  const claimNegated = NEGATION.test(compact(claim));
  const qualifiers = [...cStems].filter((s) => QUALIFIERS.has(s));
  const topic = [...cStems].filter((s) => !QUALIFIERS.has(s));

  const shared = topic.filter((s) => pStems.has(s));
  const share = topic.length === 0 ? 0 : shared.length / topic.length;
  // A passage that speaks to the claim's qualifier ("recovery is manual") is
  // relevant on one shared subject word; one that does not needs two.
  const speaksToQualifier = qualifiers.some((q) => pStems.has(q) || (oppositeOf(q) !== null && pStems.has(oppositeOf(q) as string)));
  const need = speaksToQualifier ? 1 : Math.min(2, Math.max(1, topic.length));
  if (shared.length < need || share < RELEVANT_SHARE) {
    return { passage, stance: "none", reason: "not about the same thing" };
  }

  const negated = negatedStems(passage.text);
  const asserted = assertedStems(passage.text);

  // Reasons the passage contradicts the claim, from every rule that can say so.
  let contradicted: string | null = null;

  // 1. Numbers with their unit. Checked first: "retried automatically up to 5
  //    times" must not be waved through on the strength of "automatically".
  const cf = figures(claim);
  if (cf.length > 0) {
    const pf = figures(passage.text);
    for (const f of cf) {
      const same = pf.filter((p) => p.unit === f.unit);
      if (same.length > 0 && !same.some((p) => p.value === f.value)) {
        contradicted = `it gives ${same[0].value} ${same[0].raw}, not ${f.value}`;
      }
    }
  }

  // 2. Qualifiers. "Automatically" is the claim; the rest is scenery.
  let supportedQualifiers = 0;
  for (const q of qualifiers) {
    const opp = oppositeOf(q);
    const hasQ = pStems.has(q);
    const hasOpp = opp ? pStems.has(opp) : false;
    if (hasQ) {
      const qNeg = negated.has(q) && !asserted.has(q);
      if (qNeg !== claimNegated) contradicted = contradicted ?? `it says "${q}" does not apply`;
      else supportedQualifiers += 1;
    } else if (hasOpp && opp) {
      const oppNeg = negated.has(opp) && !asserted.has(opp);
      if (!oppNeg && !claimNegated) contradicted = contradicted ?? `it says "${opp}", not "${q}"`;
      else if (oppNeg && !claimNegated) {
        // "Automatic failover is not configured" is consistent with a claim
        // of manual failover, but it is not the sentence that proves it.
      } else supportedQualifiers += 1;
    }
  }
  if (contradicted) return { passage, stance: "contradict", reason: contradicted };
  if (qualifiers.length > 0) {
    return supportedQualifiers === qualifiers.length
      ? { passage, stance: "support", reason: "same qualifier, same subject" }
      : { passage, stance: "partial", reason: "same subject, qualifier not stated here" };
  }

  // 3. Plain polarity over the shared subject.
  const sharedNegated = shared.filter((s) => negated.has(s) && !asserted.has(s)).length;
  const passageNegated = sharedNegated / shared.length > 0.5;
  if (passageNegated !== claimNegated) {
    return { passage, stance: "contradict", reason: claimNegated ? "it asserts what the claim denies" : "it says this is not the case" };
  }
  if (share >= 0.6 || shared.length >= 3) return { passage, stance: "support", reason: "same subject, same polarity" };
  return { passage, stance: "partial", reason: "overlaps, but not every term is covered" };
}

function rank(claim: string, doc: SourceDocument): Passage[] {
  const c = new Set(contentStems(claim));
  return doc.passages
    .map((p) => {
      let hit = 0;
      for (const s of contentStems(p.text)) if (c.has(s)) hit += 1;
      return { p, hit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || a.p.ordinal - b.p.ordinal)
    .slice(0, 8)
    .map((x) => x.p);
}

/** Split "A and B" into A, B — only when each side is a claim on its own. */
export function splitClaim(claim: string): string[] {
  const parts = claim
    .split(/\s*(?:;|,\s*and\s+|\s+and\s+(?=we\b|our\b|the\b|it\b|they\b|that\b|no\b|all\b|\w+ly\b|(?:is|are|was|were|has|have|can|will)\b)|\s+plus\s+|\s+as well as\s+)\s*/i)
    .map((s) => s.trim().replace(/^[,.\s]+|[,.\s]+$/g, ""))
    .filter(Boolean);
  const real = parts.filter((p) => contentStems(p).length >= 2);
  return real.length >= 2 ? real : [claim.trim()];
}

function partVerdict(text: string, doc: SourceDocument): ClaimPart {
  const stems = contentStems(text);
  if (stems.length < 2) {
    return { text, status: "UNRESOLVED", evidencePassageIds: [], contradictionPassageIds: [], note: "Too little to check: no claim was stated." };
  }
  const judged = rank(text, doc).map((p) => judge(text, p)).filter((j) => j.stance !== "none");
  const contra = judged.filter((j) => j.stance === "contradict");
  const support = judged.filter((j) => j.stance === "support");
  const partial = judged.filter((j) => j.stance === "partial");

  if (HEDGE.test(text) && contra.length === 0 && support.length === 0) {
    return { text, status: "UNRESOLVED", evidencePassageIds: [], contradictionPassageIds: [], note: "Said as a maybe, so there is no claim to check yet." };
  }
  if (contra.length > 0) {
    return {
      text,
      status: "CONTRADICTED",
      evidencePassageIds: support.map((j) => j.passage.id),
      contradictionPassageIds: contra.map((j) => j.passage.id),
      note: `The document disagrees: ${contra[0].reason}.`,
    };
  }
  if (support.length > 0) {
    return { text, status: "SUPPORTED", evidencePassageIds: support.map((j) => j.passage.id), contradictionPassageIds: [], note: "The document says this." };
  }
  if (partial.length > 0) {
    return { text, status: "PARTIAL", evidencePassageIds: partial.map((j) => j.passage.id), contradictionPassageIds: [], note: `Only part is covered: ${partial[0].reason}.` };
  }
  return { text, status: "UNSUPPORTED", evidencePassageIds: [], contradictionPassageIds: [], note: "No relevant passage was found." };
}

function overall(parts: ClaimPart[]): ClaimStatus {
  const s = parts.map((p) => p.status);
  if (s.includes("CONTRADICTED")) return "CONTRADICTED";
  if (s.every((x) => x === "SUPPORTED")) return "SUPPORTED";
  if (s.every((x) => x === "UNRESOLVED")) return "UNRESOLVED";
  if (s.every((x) => x === "UNSUPPORTED" || x === "UNRESOLVED")) return "UNSUPPORTED";
  return "PARTIAL";
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

function confidenceOf(status: ClaimStatus, parts: ClaimPart[]): number {
  const n = Math.max(1, parts.length);
  const backed = parts.filter((p) => p.status === "SUPPORTED" || p.status === "CONTRADICTED").length;
  const base = { SUPPORTED: 0.8, CONTRADICTED: 0.85, PARTIAL: 0.55, UNSUPPORTED: 0.7, UNRESOLVED: 0.3 }[status];
  // The share of the claim that a passage actually decided.
  return Math.round(Math.min(0.95, base * (0.6 + 0.4 * (backed / n))) * 100) / 100;
}

/**
 * Evaluate a claim against a document. Pure: same words in, same verdict out.
 *
 * The evidence ids returned are copied from `doc.passages`. There is no code
 * path that puts any other string in them.
 */
export function evaluateClaim(claim: string, doc: SourceDocument): Verdict {
  const parts = splitClaim(claim).map((c) => partVerdict(c, doc));
  const status = overall(parts);
  const evidence = uniq(parts.flatMap((p) => p.evidencePassageIds));
  const contradiction = uniq(parts.flatMap((p) => p.contradictionPassageIds));

  const basis =
    status === "SUPPORTED"
      ? "The document states this."
      : status === "CONTRADICTED"
        ? parts.find((p) => p.status === "CONTRADICTED")?.note ?? "The document disagrees."
        : status === "PARTIAL"
          ? "The document backs part of this claim, not all of it."
          : status === "UNSUPPORTED"
            ? "I could not find this in the supplied material."
            : "There is not enough here to conclude.";

  return {
    status,
    evidencePassageIds: status === "UNSUPPORTED" || status === "UNRESOLVED" ? [] : evidence,
    contradictionPassageIds: contradiction,
    confidence: confidenceOf(status, parts),
    parts: parts.length > 1 || status === "PARTIAL" ? parts : [],
    basis,
  };
}

/**
 * The gate every verdict passes before it reaches the ledger.
 *
 * `evaluateClaim` cannot produce a verdict without evidence, but the ledger
 * does not rely on that. This is the second lock: whoever built the verdict —
 * this engine, a future model adjudicator, a test — a status that needs
 * evidence and has none, or cites a passage the document does not contain, is
 * downgraded here to what the evidence actually supports.
 */
export function enforceGrounding(v: Verdict, doc: SourceDocument): Verdict {
  const known = new Set(doc.passages.map((p) => p.id));
  const evidence = v.evidencePassageIds.filter((id) => known.has(id));
  const contradiction = v.contradictionPassageIds.filter((id) => known.has(id));
  let status = v.status;
  let basis = v.basis;
  if (status === "SUPPORTED" && evidence.length === 0) {
    status = "UNSUPPORTED";
    basis = "I could not find this in the supplied material.";
  }
  if (status === "CONTRADICTED" && contradiction.length === 0) {
    status = evidence.length > 0 ? "PARTIAL" : "UNSUPPORTED";
    basis = status === "PARTIAL" ? "The document backs part of this claim, not all of it." : "I could not find this in the supplied material.";
  }
  if (status === "PARTIAL" && evidence.length === 0 && contradiction.length === 0) {
    status = "UNSUPPORTED";
    basis = "I could not find this in the supplied material.";
  }
  return { ...v, status, basis, evidencePassageIds: evidence, contradictionPassageIds: contradiction };
}

/** Sentences of a spoken utterance, for callers that need to pick out a claim. */
export function utteranceSentences(text: string): string[] {
  return sentences(text.trim());
}
