import { randomUUID } from "node:crypto";
import { buildDocument, isPassageOf } from "./document";
import { enforceGrounding, evaluateClaim } from "./evaluate";
import { pickChallenge, quoteOf } from "./challenge";
import { buildReport, type Report } from "./report";
import { CORRECTION_CUE, NEGATION, contentStems, figures, neutralise, numbers, QUALIFIERS, oppositeOf, stem } from "./text";
import {
  MAX_CLAIM_CHARS,
  type Challenge,
  type Claim,
  type ClaimStatus,
  type Passage,
  type RedteamSession,
  type ReviewMode,
  type TimelineEvent,
  type TimelineKind,
  type Verdict,
} from "./types";

/**
 * The Claim Ledger and everything that changes it.
 *
 * The rule of this file: the ledger is written by the server, from the
 * document, and by nothing else. The voice agent proposes words; this file
 * decides what the document says about them. There is no function here that
 * takes a status as an input.
 */

export class RedteamError extends Error {
  constructor(readonly code: "BAD_INPUT" | "UNKNOWN_CLAIM" | "UNKNOWN_PASSAGE" | "ENDED" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "RedteamError";
  }
}

const now = () => new Date().toISOString();
let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString(36)}${randomUUID().slice(0, 4)}`;

function event(s: RedteamSession, kind: TimelineKind, fields: Partial<TimelineEvent> & { text: string }): TimelineEvent {
  const e: TimelineEvent = { id: nid("e"), at: now(), kind, claimId: null, passageIds: [], ...fields };
  s.timeline.push(e);
  s.updatedAt = e.at;
  return e;
}

export function cleanSpoken(raw: unknown): string {
  if (typeof raw !== "string") throw new RedteamError("BAD_INPUT", "A claim has to be text.");
  const t = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) throw new RedteamError("BAD_INPUT", "There was no claim in that.");
  return t.slice(0, MAX_CLAIM_CHARS);
}

function assertActive(s: RedteamSession) {
  if (s.status === "ended") throw new RedteamError("ENDED", "This review has ended. Start a new one.");
}

/* ------------------------------------------------------------------ create */

export function createSession(input: {
  userId: string;
  mode: ReviewMode;
  title: string;
  text: string;
  sample?: boolean;
}): RedteamSession {
  const document = buildDocument({ ownerId: input.userId, title: input.title, text: input.text, sample: input.sample });
  const at = now();
  const s: RedteamSession = {
    id: randomUUID(),
    userId: input.userId,
    mode: input.mode,
    document,
    claims: [],
    timeline: [],
    challenges: [],
    activeClaimId: null,
    status: "active",
    turnCounter: 0,
    createdAt: at,
    updatedAt: at,
  };
  askNext(s);
  return s;
}

/* -------------------------------------------------------------- challenges */

export function askNext(s: RedteamSession): Challenge {
  assertActive(s);
  const c: Challenge = { ...pickChallenge(s), turn: s.turnCounter, at: now() };
  s.challenges.push(c);
  event(s, "challenge", { text: c.question, claimId: c.claimId, passageIds: c.groundedIn });
  return c;
}

/* ------------------------------------------------------------------ claims */

/**
 * The model's tidied-up version of what the user said is only accepted if it
 * adds nothing. A normalisation that slips in "manually", a negation or a
 * number the user never said would let the agent write the verdict it wants,
 * so anything of that kind sends us back to the user's own words.
 */
export function faithfulNormalisation(spoken: string, proposed: string | undefined | null): string {
  const s = cleanSpoken(spoken);
  if (!proposed || typeof proposed !== "string") return s;
  let p: string;
  try {
    p = cleanSpoken(proposed);
  } catch {
    return s;
  }
  const sStems = new Set(contentStems(s));
  // Nothing checkable was said: there is nothing for a tidy-up to be faithful
  // to. ("yes" must not become "Writes are idempotent by request id.")
  if (sStems.size < 2) return s;
  const pList = contentStems(p);
  const pStems = new Set(pList);
  const introduces = [...pStems].filter((x) => !sStems.has(x));
  if (introduces.some((x) => QUALIFIERS.has(x))) return s;
  // At most one new word (a pronoun resolved to its noun), and never a big share of the claim.
  if (introduces.length > 1 || introduces.length / Math.max(1, pStems.size) > 0.25) return s;
  if (NEGATION.test(p) !== NEGATION.test(s)) return s;
  const sNums = numbers(s);
  if ([...numbers(p)].some((n) => !sNums.has(n))) return s;
  const sFig = figures(s).map((f) => `${f.value}${f.unit}`);
  if (figures(p).some((f) => !sFig.includes(`${f.value}${f.unit}`))) return s;
  // The user's own words must still be in it.
  const kept = [...sStems].filter((x) => pStems.has(x)).length;
  if (kept / sStems.size < 0.6) return s;
  return p;
}

/** The claim a correction is about: the one waiting on it, or the one being explained. */
function correctionTarget(s: RedteamSession, spoken: string): Claim | null {
  if (!CORRECTION_CUE.test(spoken)) return null;
  const c =
    s.claims.find((x) => x.awaitingCorrection) ??
    (s.explainingClaimId ? s.claims.find((x) => x.id === s.explainingClaimId) : undefined) ??
    null;
  if (!c) return null;
  // A correction has to be about the claim. "No, I think we page the on-call
  // engineer" shares nothing with a claim about replicas, so it is a new claim.
  const frag = new Set(contentStems(correctionFragment(spoken)));
  const have = new Set(contentStems(c.normalizedClaim));
  const related = [...frag].some((x) => QUALIFIERS.has(x) || have.has(x));
  return related ? c : null;
}

/** The user has moved on: nothing is waiting on a correction, and no explanation is in flight. */
function userMovedOn(s: RedteamSession) {
  for (const c of s.claims) c.awaitingCorrection = false;
  s.explainingClaimId = null;
}

const FINISH_CUE =
  /(?:\b(?:i'?m done|i am done|we'?re done|we are done|all done|let'?s (?:finish|stop|wrap up)|finish (?:the |this )?(?:review|session|now|up)|that'?s (?:all|it|enough)(?: for (?:now|today))?|end (?:the |this )?(?:review|session)|wrap (?:it |this )?up|stop (?:the |this )?(?:review|session)|show (?:me )?the report|give me the report|build the report)\b)|^\s*(?:finish|done|stop)[.!]?\s*$/i;

/** Did the user, in their last few turns, ask for the review to end? */
export function userAskedToFinish(s: RedteamSession): boolean {
  return (s.recentUtterances ?? []).slice(-3).some((u) => FINISH_CUE.test(u));
}

function verdictOf(s: RedteamSession, text: string): Verdict {
  return enforceGrounding(evaluateClaim(text, s.document), s.document);
}

function apply(claim: Claim, v: Verdict, cause: "spoken" | "correction" | "retry", normalized: string) {
  claim.normalizedClaim = normalized;
  claim.status = v.status;
  claim.evidencePassageIds = v.evidencePassageIds;
  claim.contradictionPassageIds = v.contradictionPassageIds;
  claim.confidence = v.confidence;
  claim.parts = v.parts;
  claim.basis = v.basis;
  claim.updatedAt = now();
  claim.revisions.push({
    at: claim.updatedAt,
    cause,
    normalizedClaim: normalized,
    status: v.status,
    evidencePassageIds: v.evidencePassageIds,
    contradictionPassageIds: v.contradictionPassageIds,
  });
}

export type ClaimOutcome = { claim: Claim; previousStatus: ClaimStatus | null; corrected: boolean };

/** Record a claim the user just made, or fold it in as a correction if one is pending. */
export function recordSpokenClaim(
  s: RedteamSession,
  input: { spoken: unknown; normalized?: string | null; passageHints?: unknown }
): ClaimOutcome {
  assertActive(s);
  const spoken = cleanSpoken(input.spoken);
  if (input.passageHints !== undefined) validateHints(s, input.passageHints);

  const target = correctionTarget(s, spoken);
  if (target) return applyCorrection(s, target.id, spoken);

  const normalized = faithfulNormalisation(spoken, input.normalized);

  // The browser reports every finished user turn AND the agent calls the tool
  // for the same words. That must be one claim, not two.
  const recent = s.claims.at(-1);
  if (recent && Date.now() - Date.parse(recent.createdAt) < 30_000 && sameClaim(recent, spoken, normalized)) {
    s.activeClaimId = recent.id;
    return { claim: recent, previousStatus: null, corrected: false };
  }

  s.turnCounter += 1;
  const v = verdictOf(s, normalized);
  const at = now();
  const claim: Claim = {
    id: nid("c"),
    sessionId: s.id,
    turnId: `t${s.turnCounter}`,
    spokenText: spoken,
    normalizedClaim: normalized,
    status: v.status,
    evidencePassageIds: v.evidencePassageIds,
    contradictionPassageIds: v.contradictionPassageIds,
    confidence: v.confidence,
    parts: v.parts,
    basis: v.basis,
    awaitingCorrection: false,
    revisions: [],
    createdAt: at,
    updatedAt: at,
  };
  claim.revisions.push({
    at,
    cause: "spoken",
    normalizedClaim: normalized,
    status: v.status,
    evidencePassageIds: v.evidencePassageIds,
    contradictionPassageIds: v.contradictionPassageIds,
  });
  s.claims.push(claim);
  s.activeClaimId = claim.id;
  userMovedOn(s);
  event(s, "claim", { text: spoken, claimId: claim.id });
  event(s, "verdict", {
    text: v.basis,
    claimId: claim.id,
    to: v.status,
    passageIds: [...v.evidencePassageIds, ...v.contradictionPassageIds],
  });
  return { claim, previousStatus: null, corrected: false };
}

function jaccard(a: string, b: string): number {
  const x = new Set(contentStems(a));
  const y = new Set(contentStems(b));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const k of x) if (y.has(k)) both += 1;
  return both / (x.size + y.size - both);
}

const figureKey = (s: string) => figures(s).map((f) => `${f.value}${f.unit}`).sort().join(",");

const qualifierKey = (s: string) => contentStems(s).filter((x) => QUALIFIERS.has(x)).sort().join(",");

/**
 * The same words, not merely similar ones. A changed number, a flipped
 * negation or a different qualifier ("automatically" vs "manually") is a
 * different claim however many other words it shares, and folding it into the
 * previous one would report the earlier verdict for it. Two texts are the same
 * claim when one says nothing the other does not, or they are nearly identical.
 */
function sameClaim(c: Claim, spoken: string, normalized: string): boolean {
  return [c.spokenText, c.normalizedClaim].some((existing) =>
    [spoken, normalized].some((mine) => {
      if (figureKey(existing) !== figureKey(mine)) return false;
      if (NEGATION.test(existing) !== NEGATION.test(mine)) return false;
      if (qualifierKey(existing) !== qualifierKey(mine)) return false;
      if (numbers(existing).size !== numbers(mine).size) return false;
      const a = new Set(contentStems(existing));
      const b = new Set(contentStems(mine));
      if (a.size < 2 || b.size < 2) return false;
      const aInB = [...a].every((x) => b.has(x));
      const bInA = [...b].every((x) => a.has(x));
      return aInB || bInA || jaccard(existing, mine) >= 0.85;
    })
  );
}

const NOT_A_CLAIM_START = /^(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|will|please|ok|okay|yes|no|yeah|yep|sure|hello|hi|hey|thanks|thank|right|so|go|start|begin|next|stop|repeat|continue|finish|skip|again|let|lets|um|uh|hmm)\b/i;

/** "Yes, we fail over…": the answer is what follows the acknowledgement. */
export function stripLead(text: string): string {
  return text.trim().replace(/^(?:(?:yes|yeah|yep|sure|right|so|well|okay|ok|no|um|uh|hmm)\b[,.\s]*)+/i, "").trim();
}

/** Is this utterance something to check against the document, or just talk? */
export function looksLikeClaim(text: string): boolean {
  const t = stripLead(text);
  if (t.length < 12 || t.endsWith("?") || NOT_A_CLAIM_START.test(t)) return false;
  // "That's all, I'm done. Show me the report." is a request, not a claim.
  if (FINISH_CUE.test(t) && contentStems(t).length <= 3) return false;
  if (/^(?:that'?s (?:all|it)|i'?m done|we'?re done|show me|give me|move on|let'?s move on|say (?:that|it) again)\b/i.test(t)) return false;
  return t.split(/\s+/).length >= 3 && contentStems(t).length >= 2;
}

/**
 * A finished user turn as the browser saw it on the socket.
 *
 * A correction after a barge-in re-checks the claim that was interrupted. A
 * plain statement is recorded as a claim. Talk (a question, "okay", "repeat
 * that") is left alone. The agent's own tool call for the same words lands on
 * the claim this creates, so the map does not depend on the model choosing to
 * call a tool, and a model that does call one does not double it.
 */
export function recordUtterance(s: RedteamSession, text: string): (ClaimOutcome & { recorded: boolean }) | null {
  assertActive(s);
  const spoken = cleanSpoken(text);
  s.recentUtterances = [...(s.recentUtterances ?? []), spoken].slice(-6);
  const target = correctionTarget(s, spoken);
  if (target) return { ...applyCorrection(s, target.id, spoken), recorded: true };
  // Anything else means the user has moved on from the reply that was cut off.
  userMovedOn(s);
  if (!looksLikeClaim(spoken)) return null;
  const before = s.claims.length;
  const out = recordSpokenClaim(s, { spoken: stripLead(spoken) });
  return { ...out, recorded: s.claims.length > before };
}

/** The agent finished speaking a reply that carried no tool result: any explanation is over. */
export function endExplanation(s: RedteamSession): void {
  s.explainingClaimId = null;
}

/** A verdict has just been handed to the agent, which will now explain it. */
export function beginExplanation(s: RedteamSession, claimId: string): void {
  s.explainingClaimId = claimId;
}

/** Passage ids an agent names must be this document's. Anything else is refused whole. */
function validateHints(s: RedteamSession, hints: unknown) {
  if (!Array.isArray(hints)) throw new RedteamError("BAD_INPUT", "Passage ids must be a list.");
  for (const id of hints) {
    if (!isPassageOf(s.document, id)) {
      throw new RedteamError("UNKNOWN_PASSAGE", "That passage is not in this document. Use only ids the source tools returned.");
    }
  }
}

/* ----------------------------------------------------- interruption / fixes */

/** The user cut the agent off while it was explaining a verdict. */
export function markInterrupted(s: RedteamSession): Claim | null {
  assertActive(s);
  // Only the reply that was explaining a verdict can leave a claim waiting for
  // a correction. Cutting off the next question is not a comment on an old claim.
  const claim = s.explainingClaimId ? s.claims.find((c) => c.id === s.explainingClaimId) ?? null : null;
  if (!claim) {
    // The correction can arrive before the interruption is reported; the
    // ledger has already moved, and the timeline should still say why.
    const last = s.timeline.at(-1);
    const fixed = last?.kind === "correction" && last.claimId ? s.claims.find((c) => c.id === last.claimId) : undefined;
    if (fixed) {
      event(s, "interruption", { text: `Interrupted while explaining: "${fixed.normalizedClaim}"`, claimId: fixed.id });
      return null;
    }
    event(s, "interruption", { text: "The user interrupted between claims." });
    return null;
  }
  claim.awaitingCorrection = true;
  claim.updatedAt = now();
  s.explainingClaimId = null;
  event(s, "interruption", { text: `Interrupted while explaining: "${claim.normalizedClaim}"`, claimId: claim.id, from: claim.status });
  return claim;
}

const CUE_SPLIT = /(?:\bi\s+meant\b|\bi\s+mean\b|\bwhat\s+i\s+meant\s+(?:was|is)\b|\bi\s+said\b|\bi\s+should\s+have\s+said\b|\bcorrection\b|\brather\b|\bto\s+be\s+clear\b|\bactually\b)[\s,:]*/i;

/** The words of a correction with the throat-clearing taken off. */
export function correctionFragment(spoken: string): string {
  const t = cleanSpoken(spoken);
  const m = CUE_SPLIT.exec(t);
  let frag = m ? t.slice(m.index + m[0].length) : t;
  frag = frag.replace(/^(?:wait|hold on|sorry|no|um|uh|so|well)\b[\s,.!:-]*/i, "").replace(/^(?:wait|hold on|sorry|no)\b[\s,.!:-]*/i, "");
  return frag.replace(/[.!?\s]+$/g, "").trim();
}

/**
 * Turn "I meant manual failover" into the corrected claim.
 *
 * A fragment that is a claim on its own is used as it stands. One that is only
 * a changed word ("manual") replaces the qualifier in the original sentence,
 * so the corrected claim keeps its subject. Either way the result is the
 * user's words, not the agent's.
 */
export function correctedClaimText(original: string, spoken: string): string {
  const frag = correctionFragment(spoken);
  if (!frag) return original;
  const fragStems = contentStems(frag);
  const fragQualifiers = fragStems.filter((x) => QUALIFIERS.has(x));
  const origWords = original.split(/\s+/);
  if (fragQualifiers.length > 0) {
    const q = fragQualifiers[0];
    const fragWord = frag.split(/\s+/).find((w) => stem(w) === q) ?? q;
    let swapped = false;
    const out = origWords.map((w) => {
      const st = stem(w.replace(/[^A-Za-z]/g, ""));
      if (!swapped && QUALIFIERS.has(st) && st !== q && oppositeOf(st) === q) {
        swapped = true;
        const bare = w.replace(/[^A-Za-z]/g, "");
        const adverb = /ly$/i.test(bare) && !/ly$/i.test(fragWord);
        return w.replace(bare, adverb ? `${fragWord}ly` : fragWord);
      }
      return w;
    });
    if (swapped) return out.join(" ");
  }
  if (fragStems.length >= 2) return frag;
  return `${original} (clarified: ${frag})`;
}

/** True when this claim already carries a correction that says everything `target` says. */
function alreadyApplied(claim: Claim, target: string): boolean {
  if (claim.normalizedClaim === target) return true;
  if (!claim.revisions.some((r) => r.cause === "correction")) return false;
  const have = new Set(contentStems(claim.normalizedClaim));
  return contentStems(target).every((x) => have.has(x));
}

/**
 * Re-check a claim in light of what the user just said. Searches the document
 * again from scratch; the previous verdict is not an input.
 */
export function applyCorrection(s: RedteamSession, claimId: string, spoken: string, proposed?: string | null): ClaimOutcome {
  assertActive(s);
  const claim = s.claims.find((c) => c.id === claimId);
  if (!claim) throw new RedteamError("UNKNOWN_CLAIM", "There is no such claim in this review.");
  const cleaned = cleanSpoken(spoken);
  const target = proposed ? faithfulNormalisation(correctedClaimText(claim.normalizedClaim, cleaned), proposed) : correctedClaimText(claim.normalizedClaim, cleaned);

  const previousStatus = claim.status;
  // Idempotent: the same correction arriving twice (browser and agent both
  // reporting it) is one revision, not two.
  if (!claim.awaitingCorrection && alreadyApplied(claim, target)) {
    return { claim, previousStatus, corrected: false };
  }
  const v = verdictOf(s, target);
  apply(claim, v, "correction", target);
  claim.awaitingCorrection = false;
  s.activeClaimId = claim.id;
  s.explainingClaimId = null;
  event(s, "correction", {
    text: cleaned,
    claimId: claim.id,
    from: previousStatus,
    to: v.status,
    passageIds: [...v.evidencePassageIds, ...v.contradictionPassageIds],
  });
  return { claim, previousStatus, corrected: true };
}

/** Re-check with the user's own new wording, when the agent carries it. */
export function reevaluateClaim(s: RedteamSession, input: { claimId: unknown; correctedClaim: unknown }): ClaimOutcome {
  assertActive(s);
  if (typeof input.claimId !== "string") throw new RedteamError("BAD_INPUT", "A claim id is required.");
  const claim = s.claims.find((c) => c.id === input.claimId);
  if (!claim) throw new RedteamError("UNKNOWN_CLAIM", "There is no such claim in this review.");
  const spoken = cleanSpoken(input.correctedClaim);
  // A corrected claim must be the user's words: if it says nothing they did
  // not say in the last turns, it is applied; the engine decides the rest.
  return applyCorrection(s, claim.id, spoken, null);
}

/* ---------------------------------------------------------------- lookups */

export type SourceHit = { passageId: string; section: string; text: string; ordinal: number };

export function searchSource(s: RedteamSession, query: unknown, limit = 4): SourceHit[] {
  const q = cleanSpoken(query);
  const qs = new Set(contentStems(q));
  return s.document.passages
    .map((p) => ({ p, hit: contentStems(p.text).filter((x) => qs.has(x)).length }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || a.p.ordinal - b.p.ordinal)
    .slice(0, limit)
    .map(({ p }) => hitOf(p));
}

export function hitOf(p: Passage): SourceHit {
  return { passageId: p.id, section: p.section, text: quoteOf(p, 420), ordinal: p.ordinal };
}

export function passagesOf(s: RedteamSession, ids: string[]): SourceHit[] {
  const by = new Map(s.document.passages.map((p) => [p.id, p]));
  return ids.map((id) => by.get(id)).filter((p): p is Passage => Boolean(p)).map(hitOf);
}

/* ----------------------------------------------------------------- finish */

export function finish(s: RedteamSession): Report {
  if (s.status !== "ended") {
    s.status = "ended";
    event(s, "finish", { text: "The review ended." });
  }
  return buildReport(s);
}

/** For the API: the session without the raw document body twice over. */
export function publicView(s: RedteamSession) {
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    activeClaimId: s.activeClaimId,
    document: {
      id: s.document.id,
      title: s.document.title,
      sample: s.document.sample,
      sections: s.document.sections,
      passages: s.document.passages,
    },
    claims: s.claims,
    timeline: s.timeline,
    challenges: s.challenges,
    updatedAt: s.updatedAt,
  };
}

export { neutralise };
