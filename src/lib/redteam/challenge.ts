import type { Challenge, ChallengeKind, Passage, RedteamSession, ReviewMode } from "./types";
import { neutralise } from "./text";

/**
 * What to ask next.
 *
 * Every question is built from two things only: a passage of the document, and
 * something the user has already said. There is no bank of generic questions
 * to fall back on — when nothing is left worth asking, the answer is ADVANCE,
 * which says so instead of padding.
 *
 * The three modes are three weightings of the same policy, not three agents.
 */

const MODE_WEIGHTS: Record<ReviewMode, { re: RegExp; w: number }[]> = {
  ARCHITECT: [
    { re: /\b(?:single|one|only)\b/i, w: 3 },
    { re: /\b(?:primary|replica|shard|partition|queue|interface|api|schema|scal\w*|throughput|latency|depend\w*|assum\w*|trade-?off)\b/i, w: 2 },
    { re: /\b(?:consisten\w*|concurren\w*|idempoten\w*|failover)\b/i, w: 2 },
  ],
  SKEPTIC: [
    { re: /\b(?:single|one|only)\b/i, w: 3 },
    { re: /\b(?:guarantee\w*|must|always|never|every|all|cite|evidence|reject\w*|bounded)\b/i, w: 2 },
    { re: /\b(?:not|no)\b/i, w: 1 },
  ],
  OPERATOR: [
    { re: /\b(?:recover\w*|manual|on-?call|alert\w*|dashboard\w*|trac\w*|monitor\w*|backup|retention|retained|delet\w*|incident|deploy\w*|rollback)\b/i, w: 3 },
    { re: /\b(?:single|only|not)\b/i, w: 1 },
  ],
};

export function quoteOf(p: Passage, max = 260): string {
  const t = neutralise(p.text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function score(p: Passage, mode: ReviewMode): number {
  let s = 0;
  for (const { re, w } of MODE_WEIGHTS[mode]) if (re.test(p.text)) s += w;
  // Headings-only or trivially short lines are not worth a question.
  if (p.text.length < 25) s = 0;
  return s;
}

function lowerFirst(s: string): string {
  return s.length > 1 && /[A-Z][a-z]/.test(s.slice(0, 2)) ? s[0].toLowerCase() + s.slice(1) : s;
}

function fromPassage(p: Passage, mode: ReviewMode): { kind: ChallengeKind; question: string } {
  const q = lowerFirst(quoteOf(p).replace(/[.!?]+$/, ""));
  if (/\b(?:single|one|only)\b/i.test(p.text) && /\b(?:primary|instance|node|server|worker|region|database)\b/i.test(p.text)) {
    return { kind: "STRESS_TEST", question: `Your document says ${q}. What happens if that becomes unavailable during an active request?` };
  }
  if (/\b(?:two|both|concurrent\w*|simultaneous\w*|same time|same submission)\b/i.test(p.text)) {
    return { kind: "EDGE_CASE", question: `Your document says ${q}. What happens when two of those arrive at the same time?` };
  }
  if (/\b(?:not|no|without|lack\w*)\b/i.test(p.text)) {
    return { kind: "STRESS_TEST", question: `Your document admits ${q}. Who accepts that risk, and why is it acceptable?` };
  }
  if (mode === "SKEPTIC") return { kind: "VERIFY", question: `Your document claims ${q}. Where is that actually enforced?` };
  if (mode === "OPERATOR") return { kind: "STRESS_TEST", question: `Your document says ${q}. How would an operator notice, at three in the morning, that this had gone wrong?` };
  return { kind: "STRESS_TEST", question: `Your document says ${q}. What breaks first when the load doubles?` };
}

let seq = 0;
function challengeId(): string {
  seq += 1;
  return `q${Date.now().toString(36)}${seq}`;
}

/**
 * Choose the next challenge. Deterministic for a given ledger.
 * Does not mutate the session; the caller records it.
 */
export function pickChallenge(session: RedteamSession): Omit<Challenge, "at" | "turn"> {
  const asked = new Set(session.challenges.map((c) => `${c.kind}:${c.claimId ?? ""}`));
  const covered = new Set(session.challenges.flatMap((c) => c.groundedIn));
  const doc = session.document;
  const byId = new Map(doc.passages.map((p) => [p.id, p]));

  // 1. A contradiction the user has not yet been confronted with.
  for (const c of session.claims) {
    if (c.status === "CONTRADICTED" && !c.awaitingCorrection && !asked.has(`CONTRADICT:${c.id}`)) {
      const p = byId.get(c.contradictionPassageIds[0]);
      if (p) {
        return {
          id: challengeId(),
          kind: "CONTRADICT",
          claimId: c.id,
          groundedIn: [p.id],
          question: `You said "${c.normalizedClaim}". Your document says: "${quoteOf(p)}" Which of the two is right?`,
        };
      }
    }
  }
  // 2. A claim nothing in the document backs.
  for (const c of session.claims) {
    if (c.status === "UNSUPPORTED" && !asked.has(`VERIFY:${c.id}`)) {
      return {
        id: challengeId(),
        kind: "VERIFY",
        claimId: c.id,
        groundedIn: [],
        question: `I can't find "${c.normalizedClaim}" in the supplied material. Where does the document establish it?`,
      };
    }
  }
  // 3. A claim only partly backed.
  for (const c of session.claims) {
    if (c.status === "PARTIAL" && !asked.has(`CLARIFY:${c.id}`)) {
      const gap = c.parts.find((p) => p.status !== "SUPPORTED");
      return {
        id: challengeId(),
        kind: "CLARIFY",
        claimId: c.id,
        groundedIn: c.evidencePassageIds.slice(0, 1),
        question: gap
          ? `Part of what you said is backed, but I can't back "${gap.text}". What supports that part?`
          : `Only part of "${c.normalizedClaim}" is in the document. Which part are you relying on?`,
      };
    }
  }
  // 4. Something the document says that has not been tested yet.
  const candidates = doc.passages
    .filter((p) => !covered.has(p.id))
    .map((p) => ({ p, s: score(p, session.mode) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.ordinal - b.p.ordinal);

  const held = session.claims.find((c) => c.status === "SUPPORTED");
  if (held && !asked.has("CONNECT:") && !session.challenges.some((c) => c.kind === "CONNECT")) {
    const heldSection = new Set(held.evidencePassageIds.map((id) => byId.get(id)?.sectionId));
    const other = candidates.find((x) => !heldSection.has(x.p.sectionId));
    if (other) {
      return {
        id: challengeId(),
        kind: "CONNECT",
        claimId: held.id,
        groundedIn: [other.p.id],
        question: `Earlier you said "${held.normalizedClaim}". Now consider: "${quoteOf(other.p)}" Do those two hold together?`,
      };
    }
  }
  if (candidates.length > 0) {
    const { p } = candidates[0];
    const { kind, question } = fromPassage(p, session.mode);
    return { id: challengeId(), kind, claimId: null, groundedIn: [p.id], question };
  }
  return {
    id: challengeId(),
    kind: "ADVANCE",
    claimId: null,
    groundedIn: [],
    question: "I have tested the parts of this document that I can find a question for. Say finish when you want the report.",
  };
}
