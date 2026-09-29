import type { Claim, Passage, RedteamSession } from "./types";
import { quoteOf } from "./challenge";

/**
 * The Defensibility Report.
 *
 * Sections, not a score. "72% defensible" would be a number nobody could
 * defend, and the point of the product is that every line here points at a
 * sentence the user can go and read.
 */

export type ReportEvidence = { passageId: string; section: string; quote: string };

export type ReportClaim = {
  claimId: string;
  claim: string;
  spoken: string;
  status: Claim["status"];
  basis: string;
  evidence: ReportEvidence[];
  contradictions: ReportEvidence[];
  /** Set when a correction moved this claim: what it was, what it became. */
  correctedFrom: { status: Claim["status"]; claim: string } | null;
};

export type Report = {
  sessionId: string;
  documentTitle: string;
  sample: boolean;
  mode: string;
  generatedAt: string;
  held: ReportClaim[];
  needsQualification: ReportClaim[];
  contradictions: ReportClaim[];
  unsupported: ReportClaim[];
  /** Questions asked that ended with no claim the document could back. */
  unanswered: { question: string; kind: string; groundedIn: ReportEvidence[] }[];
  /** Sections to reopen, with the reason each is on the list. */
  sectionsToReview: { section: string; reasons: string[] }[];
  counts: { claims: number; interruptions: number; corrections: number; questions: number };
};

function ev(byId: Map<string, Passage>, ids: string[]): ReportEvidence[] {
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is Passage => Boolean(p))
    .map((p) => ({ passageId: p.id, section: p.section, quote: quoteOf(p, 320) }));
}

export function buildReport(session: RedteamSession): Report {
  const byId = new Map(session.document.passages.map((p) => [p.id, p]));
  const rows: ReportClaim[] = session.claims.map((c) => {
    const first = c.revisions[0];
    const moved = first && (first.status !== c.status) && c.revisions.some((r) => r.cause === "correction");
    return {
      claimId: c.id,
      claim: c.normalizedClaim,
      spoken: c.spokenText,
      status: c.status,
      basis: c.basis,
      evidence: ev(byId, c.evidencePassageIds),
      contradictions: ev(byId, c.contradictionPassageIds),
      correctedFrom: moved ? { status: first.status, claim: first.normalizedClaim } : null,
    };
  });

  const sectionReasons = new Map<string, Set<string>>();
  const note = (section: string, reason: string) => {
    if (!sectionReasons.has(section)) sectionReasons.set(section, new Set());
    sectionReasons.get(section)!.add(reason);
  };
  for (const r of rows) {
    if (r.status === "CONTRADICTED") for (const e of r.contradictions) note(e.section, `contradicts "${r.claim}"`);
    if (r.status === "PARTIAL") for (const e of r.evidence) note(e.section, `only partly backs "${r.claim}"`);
    if (r.correctedFrom) for (const e of [...r.evidence, ...r.contradictions]) note(e.section, `changed the verdict on "${r.claim}" after a correction`);
  }

  const turnOf = (c: Claim) => Number(c.turnId.replace(/^t/, "")) || 0;
  const unanswered = session.challenges
    .filter((q) => q.kind !== "ADVANCE")
    .filter((q, i, all) => {
      if (q.claimId) {
        // Asked about a specific claim: answered only if that claim ended up backed.
        const c = session.claims.find((x) => x.id === q.claimId);
        return !c || c.status !== "SUPPORTED";
      }
      const until = all[i + 1]?.turn ?? Number.POSITIVE_INFINITY;
      const replies = session.claims.filter((c) => turnOf(c) > q.turn && turnOf(c) <= until);
      return !replies.some((c) => c.status === "SUPPORTED");
    })
    .map((q) => ({ question: q.question, kind: q.kind, groundedIn: ev(byId, q.groundedIn) }));

  return {
    sessionId: session.id,
    documentTitle: session.document.title,
    sample: session.document.sample,
    mode: session.mode,
    generatedAt: new Date().toISOString(),
    held: rows.filter((r) => r.status === "SUPPORTED"),
    needsQualification: rows.filter((r) => r.status === "PARTIAL"),
    contradictions: rows.filter((r) => r.status === "CONTRADICTED"),
    unsupported: rows.filter((r) => r.status === "UNSUPPORTED" || r.status === "UNRESOLVED"),
    unanswered,
    sectionsToReview: [...sectionReasons].map(([section, reasons]) => ({ section, reasons: [...reasons] })),
    counts: {
      claims: rows.length,
      interruptions: session.timeline.filter((t) => t.kind === "interruption").length,
      corrections: session.timeline.filter((t) => t.kind === "correction").length,
      questions: session.challenges.length,
    },
  };
}
