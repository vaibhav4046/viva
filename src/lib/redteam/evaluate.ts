import type { ClaimPart, ClaimStatus, Passage, SourceDocument, Verdict } from "./types";
import {
  HEDGE,
  NEG_VERBS,
  NEGATION,
  NOT_YET,
  QUALIFIERS,
  clauses,
  clockTimes,
  compact,
  contentStems,
  figures,
  numbers,
  oppositeOf,
  periods,
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

  // The reasons a passage can contradict a claim. The FIRST found is reported.
  let contradicted: string | null = null;
  const contradict = (why: string) => {
    contradicted = contradicted ?? why;
  };
  // Things the claim states that this passage does not settle either way.
  const unsettled: string[] = [];

  // 1. Numbers. Every number the claim states must be the passage's number, in
  //    the passage's unit; a different one contradicts, a missing one is
  //    simply not backed. ("30 seconds" is not "30 minutes"; "TLS 1.2" is not
  //    "TLS 1.3"; "3am" is not "09:00"; "per hour" is not "per minute".)
  const cNums = numbers(claim);
  if (cNums.size > 0) {
    const pNums = numbers(passage.text);
    const missing = [...cNums].filter((n) => !pNums.has(n));
    if (missing.length > 0) {
      if (pNums.size > 0) contradict(`it gives ${[...pNums][0]}, not ${missing[0]}`);
      else unsettled.push(`the number ${missing[0]}`);
    } else {
      const pf = figures(passage.text);
      for (const f of figures(claim)) {
        const sameValue = pf.filter((p) => p.value === f.value);
        if (sameValue.length > 0 && !sameValue.some((p) => p.unit === f.unit) && !UNIT_FILLER.has(f.unit)) {
          contradict(`it gives ${sameValue[0].value} ${sameValue[0].raw}, not ${f.value} ${f.raw}`);
        }
      }
    }
  }
  const cClock = clockTimes(claim);
  if (cClock.size > 0) {
    const pClock = clockTimes(passage.text);
    const missing = [...cClock].filter((c) => !pClock.has(c));
    if (missing.length > 0) {
      if (pClock.size > 0) contradict(`it gives ${[...pClock][0]}, not ${missing[0]}`);
      else unsettled.push(`the time ${missing[0]}`);
    }
  }
  const cPer = periods(claim);
  if (cPer.size > 0) {
    const pPer = periods(passage.text);
    if (pPer.size > 0 && ![...cPer].some((p) => pPer.has(p))) contradict(`it says per ${[...pPer][0]}, not per ${[...cPer][0]}`);
  }

  // 2. Qualifiers. "Automatically" is the claim; the rest is scenery.
  for (const q of qualifiers) {
    const opp = oppositeOf(q);
    const hasQ = pStems.has(q);
    const hasOpp = opp ? pStems.has(opp) : false;
    if (hasQ) {
      const qNeg = negated.has(q) && !asserted.has(q);
      if (qNeg !== claimNegated) contradict(`it says "${q}" does not apply`);
    } else if (hasOpp && opp) {
      const oppNeg = negated.has(opp) && !asserted.has(opp);
      if (!oppNeg && !claimNegated) contradict(`it says "${opp}", not "${q}"`);
      // "Automatic failover is not configured" is consistent with a claim of
      // manual failover, but it is not the sentence that proves it.
      else if (oppNeg) unsettled.push(q);
    } else {
      unsettled.push(q);
    }
  }

  // 3. A refusal the claim does not mention ("are rejected before they are returned").
  const refusals = [...pStems].filter((s) => NEG_VERBS.has(s) && !cStems.has(s));
  if (refusals.length > 0 && !claimNegated) contradict(`it says these are ${refusals[0]}ed`);

  // 4. Plain polarity over the shared subject.
  const sharedNegated = shared.filter((s) => negated.has(s) && !asserted.has(s)).length;
  const passageNegated = shared.length > 0 && sharedNegated / shared.length > 0.5;
  if (qualifiers.length === 0 && passageNegated !== claimNegated) {
    contradict(claimNegated ? "it asserts what the claim denies" : "it says this is not the case");
  }

  // 5. What the claim says that the passage does not. Only "only" turns that
  //    into a contradiction: "exist for reporting queries only" rules out writes.
  const uncovered = topic.filter((s) => !pStems.has(s));
  if (uncovered.length > 0) {
    if (ONLY.test(passage.text) && !claimNegated) contradict(`it says "only", which rules this out`);
    else unsettled.push(uncovered.join(", "));
  }

  if (contradicted) return { passage, stance: "contradict", reason: contradicted };
  if (unsettled.length > 0) return { passage, stance: "partial", reason: `the document does not say: ${unsettled.join("; ")}` };
  return { passage, stance: "support", reason: "same subject, same polarity, nothing left over" };
}

const ONLY = /\b(?:only|solely|exclusively)\b/i;
const UNIT_FILLER: ReadonlySet<string> = new Set(["primary", "replica", "worker", "instance", "item", "key", "other", "more", "least", "most"]);

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
  // Each sentence of an utterance is its own claim.
  const sents = sentences(claim.trim()).filter((s) => contentStems(s).length >= 1);
  if (sents.length > 1) return sents.flatMap((s) => splitClaim(s));
  const parts = claim
    .split(/\s*(?:;|,\s*and\s+|\s+and\s+(?=we\b|our\b|the\b|it\b|they\b|that\b|no\b|all\b|\w+ly\b|\w+\s+(?:is|are|was|were|has|have|can|will|does|do)\b|(?:is|are|was|were|has|have|can|will)\b)|\s+plus\s+|\s+as well as\s+)\s*/i)
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
