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
  ABSOLUTE,
  IDENT_SLOTS,
  SOFT,
  inSeconds,
  quantities,
  satisfies,
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
  // Two negations cancel: "it is not true that the trial was not pre-registered".
  const claimNegated = (compact(claim).match(new RegExp(NEGATION.source, "gi"))?.length ?? 0) % 2 === 1;
  const qualifiers = [...cStems].filter((s) => QUALIFIERS.has(s));
  const topic = [...cStems].filter((s) => !QUALIFIERS.has(s));

  const shared = topic.filter((s) => pStems.has(s));
  const share = topic.length === 0 ? 0 : shared.length / topic.length;

  // "Severity 1" and "Severity 2" are different things, not different counts.
  // A passage about another identified thing is not about this claim at all.
  const cIds = quantities(claim).filter((q) => IDENT_SLOTS.has(q.slot));
  const pIds = quantities(passage.text).filter((q) => IDENT_SLOTS.has(q.slot));
  for (const ci of cIds) {
    const same = pIds.filter((p) => p.slot === ci.slot);
    if (same.length > 0 && !same.some((p) => p.value === ci.value)) return { passage, stance: "none", reason: "about a different one" };
  }
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
  // Numbers are compared only with numbers that count the same thing: the
  // same unit, a convertible time unit, or (with no unit) the same slot word.
  // A passage that mentions some OTHER number is not a contradiction; "the
  // trial ran in 2023" says nothing against "the trial randomised 412".
  const pq = quantities(passage.text);
  for (const cq of quantities(claim).filter((q) => !IDENT_SLOTS.has(q.slot))) {
    const peers = pq.filter((p) => (cq.unit && p.unit === cq.unit) || (!cq.unit && !p.unit && cq.slot && p.slot === cq.slot));
    const cSec = inSeconds(cq);
    const timePeers = cSec === null ? [] : pq.filter((p) => inSeconds(p) !== null && p.unit !== cq.unit);
    if (peers.length === 0 && timePeers.length === 0) {
      unsettled.push(`the number ${cq.value}`);
      continue;
    }
    const all = [...peers.map((p) => ({ p, v: p.value, c: cq.value })), ...timePeers.map((p) => ({ p, v: inSeconds(p) as number, c: cSec as number }))];
    const verdicts = all.map(({ p, v, c }) => {
      const claimQ = { ...cq, value: c };
      const passQ = { ...p, value: v };
      if (p.bound === "exact") return satisfies(v, claimQ) ? (cq.bound === "exact" ? "match" : "within") : "conflict";
      // The passage gives a bound. An exact claim inside it is consistent but not stated.
      if (cq.bound === "exact") return satisfies(c, passQ) ? "within" : "conflict";
      // Bound against bound: same direction must be the same value ("up to 5"
      // is not "up to 3"); opposite directions only overlap, and settle nothing.
      if (cq.bound === p.bound) return c === v ? "match" : "conflict";
      return "within";
    });
    if (verdicts.includes("match")) continue;
    if (verdicts.includes("within")) {
      unsettled.push(`the exact figure ${cq.value}`);
      continue;
    }
    const p0 = all[0].p;
    // A different number only contradicts when the passage is about the whole
    // subject of the claim: "18% of tickets were about lost inspections" is not
    // the figure in "we will reduce lost-inspection tickets by 80%".
    const subject = topic.filter((s) => !GENERIC_VERBS.has(s) && s !== cq.unit);
    const covered = subject.length === 0 ? 1 : subject.filter((s) => pStems.has(s)).length / subject.length;
    if (covered < 0.9) {
      unsettled.push(`the figure ${cq.value}`);
      continue;
    }
    contradict(`it gives ${p0.value}${p0.unit ? " " + p0.unit : ""}, not ${cq.value}${cq.unit ? " " + cq.unit : ""}`);
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

  // A contradiction needs the passage to be about the claim's subject, not just
  // to share a word or two with it: "encrypted backups are retained for 35
  // days" says nothing against "application logs are retained for 30 days".
  // Below this share a would-be contradiction only leaves the claim unbacked.
  const core = topic.filter((s) => !GENERIC_VERBS.has(s));
  const coreShare = core.length === 0 ? share : core.filter((s) => pStems.has(s)).length / core.length;
  if (contradicted && coreShare < 0.6 && !qualifiers.some((q) => pStems.has(q) || pStems.has(oppositeOf(q) ?? ""))) {
    unsettled.push(`a passage that may disagree (${contradicted})`);
    contradicted = null;
  }

  // 3. A refusal the claim does not mention ("are rejected before they are returned").
  const refusals = [...pStems].filter((s) => NEG_VERBS.has(s) && !cStems.has(s));
  if (refusals.length > 0 && !claimNegated) contradict(`it says these are ${refusals[0]}ed`);

  // 4. Plain polarity over the shared subject.
  const sharedNegated = shared.filter((s) => negated.has(s) && !asserted.has(s)).length;
  // Two or more of the claim's words that the passage only ever says in a
  // negated clause ("…but must never view message contents") are enough.
  const passageNegated = shared.length > 0 && (sharedNegated / shared.length > 0.5 || sharedNegated >= 2);
  // The negated statement must be about the claim: either the passage covers
  // most of the claim, or most of the negated clause is the claim's own words
  // ("Distributed tracing is not implemented" against "…distributed tracing
  // in every service"). A negated clause about something else ("maintenance
  // is excluded from the uptime calculation") does not flip an uptime claim.
  const negatedClauseAboutClaim = clauses(passage.text).some((c) => {
    if (!(NEGATION.test(compact(c)) || NOT_YET.test(c))) return false;
    const own = contentStems(c).filter((s) => !GENERIC_VERBS.has(s));
    return own.length > 0 && own.filter((s) => cStems.has(s)).length / own.length >= 0.5;
  });
  if (qualifiers.length === 0 && passageNegated !== claimNegated && (coreShare >= 0.75 || negatedClauseAboutClaim) && (claimNegated || negationLandsOnClaim(passage.text, cStems))) {
    contradict(claimNegated ? "it asserts what the claim denies" : "it says this is not the case");
  }

  // 5. What the claim says that the passage does not. Only "only" turns that
  //    into a contradiction: "exist for reporting queries only" rules out writes.
  const uncovered = topic.filter((s) => !pStems.has(s) && !GENERIC_VERBS.has(s));
  if (uncovered.length > 0) {
    // "Only" rules out exactly one different thing in the slot it guards: the
    // claim adds one word the passage lacks, and the words "only" qualifies
    // are not in the claim ("reporting queries only" vs "used for writes").
    if (ONLY.test(passage.text) && !claimNegated && uncovered.length === 1 && coreShare >= 0.6 && !onlySlotMatched(passage.text, cStems)) {
      contradict(`it says "only", which rules this out`);
    } else unsettled.push(uncovered.join(", "));
  }

  // 6. A plan, an expectation or a "should" is not a fact, and a passage that
  //    is not absolute does not back an absolute claim.
  if (!contradicted && SOFT.test(passage.text) && !SOFT.test(claim)) unsettled.push("it is stated as a plan or expectation, not a fact");
  if (!contradicted && ABSOLUTE.test(claim) && !sameAbsolute(claim, passage.text)) unsettled.push("the claim is absolute and the passage is not");

  if (contradicted) return { passage, stance: "contradict", reason: contradicted };
  // Support needs the claim said in one place: its words inside one clause,
  // or two adjacent ones, that carry the claim's own polarity and are not
  // about a differently numbered thing. Words spread across a sentence that
  // says "…only to the Enterprise plan and does not cover Starter" do not add
  // up to "the SLA applies to the Starter plan".
  if (unsettled.length === 0 && !saidInOnePlace([...cStems], passage.text, claimNegated, cIds)) {
    unsettled.push("the words are spread across different statements");
  }
  if (unsettled.length > 0) return { passage, stance: "partial", reason: `the document does not say: ${unsettled.join("; ")}` };
  return { passage, stance: "support", reason: "same subject, same polarity, nothing left over" };
}

/**
 * Verbs a negation can deny a whole claim through: "tracing is not
 * implemented", "failover is not configured", "data is not shared".
 */
const STATE_VERBS: ReadonlySet<string> = new Set(["implement", "configur", "support", "availabl", "enabl", "us", "use", "test", "stor", "store", "provid", "offer", "includ", "allow", "permit", "requir", "need", "collect", "shar", "share", "sold", "sell", "track", "log", "record", "encrypt", "guarante", "possibl", "appl", "apply", "cover", "done", "perform", "run", "exist", "hav", "have", "be", "been", "planned", "plan", "retain", "kept", "keep", "made", "mak", "make", "set", "built", "build", "deploy", "ship", "releas", "releas", "measur", "count", "part", "counted"]);

/**
 * Does some negated clause deny the claim itself? The word the negation lands
 * on must be the claim's own word or a verb of being, having or doing, and the
 * clause must hold most of what the claim is about. "Exam graders did not know
 * which condition a student was in" negates knowing, and "students could not
 * be blinded" is about students; neither denies "exam graders were blind".
 */
function negationLandsOnClaim(text: string, claimStems: Set<string>): boolean {
  const core = [...claimStems].filter((s) => !GENERIC_VERBS.has(s));
  if (core.length === 0) return true;
  return clauses(text).some((c) => {
    const flat = compact(c);
    if (!(NEGATION.test(flat) || NOT_YET.test(c))) return false;
    const covered = core.filter((s) => contentStems(c).includes(s)).length / core.length;
    if (covered <= 0.5) return false;
    const m = NEGATION.exec(flat);
    if (!m) return true;
    const head = contentStems(flat.slice(m.index + m[0].length))[0];
    return head === undefined || claimStems.has(head) || STATE_VERBS.has(head);
  });
}

const ONLY = /\b(?:only|solely|exclusively)\b/i;

/** Verbs that carry no subject of their own; a claim is not "about" them. */
const GENERIC_VERBS: ReadonlySet<string> = new Set(["requir", "require", "need", "provid", "includ", "contain", "allow", "offer", "enabl", "featur", "hav", "giv", "tak"]);

/** Are the words that "only" guards (the three content words around it) already in the claim? */
function onlySlotMatched(text: string, claimStems: Set<string>): boolean {
  const toks = compact(text).split(/[^a-z0-9]+/).filter(Boolean);
  const i = toks.findIndex((w) => w === "only" || w === "solely" || w === "exclusively");
  if (i < 0) return false;
  const after = contentStems(toks.slice(i + 1, i + 6).join(" ")).slice(0, 3);
  const slot = after.length > 0 ? after : contentStems(toks.slice(Math.max(0, i - 5), i).join(" ")).slice(-3);
  return slot.length > 0 && slot.every((s) => claimStems.has(s));
}

/** Clause-sized fragments of a passage: split at punctuation and at conjunctions. */
function fragments(text: string): string[] {
  return text
    .split(/[,;:]\s*|\s+—\s+|\s+-\s+|\s+(?:and|but|while|whereas|however|although)\s+/i)
    .map((f) => f.trim())
    .filter(Boolean);
}

function saidInOnePlace(claimStems: string[], text: string, claimNegated: boolean, claimIds: { slot: string; value: number }[]): boolean {
  const need = claimStems.filter((s) => !GENERIC_VERBS.has(s));
  if (need.length === 0) return true;
  const usable = fragments(text).map((f) => {
    const negated = NEGATION.test(compact(f)) || NOT_YET.test(f);
    const ids = quantities(f).filter((q) => IDENT_SLOTS.has(q.slot));
    const otherThing = claimIds.some((ci) => ids.some((q) => q.slot === ci.slot && q.value !== ci.value));
    return negated === claimNegated && !otherThing ? new Set(contentStems(f)) : null;
  });
  for (let i = 0; i < usable.length; i++) {
    const a = usable[i];
    if (!a) continue;
    if (need.every((s) => a.has(s))) return true;
    const b = usable[i + 1];
    if (b && need.every((s) => a.has(s) || b.has(s))) return true;
  }
  return false;
}

function sameAbsolute(claim: string, passage: string): boolean {
  const words = (s: string) => new Set((s.toLowerCase().match(new RegExp(ABSOLUTE.source, "gi")) ?? []).map((w) => w.toLowerCase()));
  const p = words(passage);
  return [...words(claim)].every((w) => p.has(w));
}
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
