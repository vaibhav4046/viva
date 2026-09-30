import { z } from "zod";

/**
 * The vocabulary of a RedTeam session. One place, so the engine, the tools,
 * the routes and the screen cannot drift apart on what a verdict is.
 */

export const CLAIM_STATUSES = ["SUPPORTED", "PARTIAL", "CONTRADICTED", "UNSUPPORTED", "UNRESOLVED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);

export const REVIEW_MODES = ["ARCHITECT", "SKEPTIC", "OPERATOR"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
export const ReviewModeSchema = z.enum(REVIEW_MODES);

export const CHALLENGE_KINDS = ["VERIFY", "CONTRADICT", "CLARIFY", "STRESS_TEST", "EDGE_CASE", "CONNECT", "ADVANCE"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

/** One citable unit of the document. `id` is derived, never chosen by a caller. */
export type Passage = {
  id: string;
  sectionId: string;
  section: string;
  ordinal: number;
  text: string;
};

export type Section = { id: string; heading: string; ordinal: number; passageIds: string[] };

export type SourceDocument = {
  /** Content-derived. Two different documents cannot share passage ids. */
  id: string;
  title: string;
  /** Sample material is labelled as such everywhere it is shown. */
  sample: boolean;
  sections: Section[];
  passages: Passage[];
};

/** Which part of a compound claim the source did or did not stand behind. */
export type ClaimPart = {
  text: string;
  status: ClaimStatus;
  evidencePassageIds: string[];
  contradictionPassageIds: string[];
  note: string;
};

/** What the engine concluded, before it is written to the ledger. */
export type Verdict = {
  status: ClaimStatus;
  evidencePassageIds: string[];
  contradictionPassageIds: string[];
  confidence: number;
  parts: ClaimPart[];
  /** One plain sentence saying why. Built from the evidence, not from a model. */
  basis: string;
};

/** A status change on one claim. Only auditable product state — no reasoning. */
export type ClaimRevision = {
  at: string;
  cause: "spoken" | "correction" | "retry";
  normalizedClaim: string;
  status: ClaimStatus;
  evidencePassageIds: string[];
  contradictionPassageIds: string[];
};

export type Claim = {
  id: string;
  sessionId: string;
  turnId: string;
  spokenText: string;
  normalizedClaim: string;
  status: ClaimStatus;
  evidencePassageIds: string[];
  contradictionPassageIds: string[];
  confidence: number;
  parts: ClaimPart[];
  basis: string;
  /** Set between a barge-in and the correction that follows it. */
  awaitingCorrection: boolean;
  revisions: ClaimRevision[];
  createdAt: string;
  updatedAt: string;
};

export type TimelineKind = "challenge" | "claim" | "verdict" | "interruption" | "correction" | "finish";

export type TimelineEvent = {
  id: string;
  at: string;
  kind: TimelineKind;
  claimId: string | null;
  /** The question asked, the words spoken, or the change made. */
  text: string;
  from?: ClaimStatus;
  to?: ClaimStatus;
  passageIds: string[];
};

export type Challenge = {
  id: string;
  kind: ChallengeKind;
  question: string;
  /** Passages the question is built from. Empty only for ADVANCE. */
  groundedIn: string[];
  claimId: string | null;
  /** `turnCounter` when it was asked: claims made after it are its answer. */
  turn: number;
  at: string;
};

export type RedteamSession = {
  id: string;
  userId: string;
  mode: ReviewMode;
  document: SourceDocument;
  claims: Claim[];
  timeline: TimelineEvent[];
  challenges: Challenge[];
  activeClaimId: string | null;
  /**
   * The claim whose verdict the agent is explaining right now. Set when a
   * verdict is handed to the agent; cleared when that explanation ends, when
   * the next question is asked, or when the user moves on. A barge-in only
   * marks a claim if the reply it cut was this one.
   */
  explainingClaimId?: string | null;
  /** The last few things the user said, so `finish` can check they asked for it. */
  recentUtterances?: string[];
  status: "active" | "ended";
  turnCounter: number;
  createdAt: string;
  updatedAt: string;
};

export const MAX_DOC_CHARS = 60_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_CLAIM_CHARS = 1_000;
