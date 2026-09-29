import { z } from "zod";
import {
  RedteamError,
  askNext,
  finish,
  hitOf,
  markInterrupted,
  passagesOf,
  publicView,
  recordSpokenClaim,
  reevaluateClaim,
  searchSource,
} from "./session";
import { MAX_CLAIM_CHARS, type Claim, type RedteamSession } from "./types";

/**
 * What the voice agent is allowed to do.
 *
 * Six tools. Each takes typed, validated input and returns typed output; none
 * takes a verdict as input, and none can name a passage the session's own
 * document did not mint. The agent reads and proposes; the server decides.
 *
 *   retrieve_source          look something up in the document
 *   evaluate_spoken_claim    record a claim and have the document judge it
 *   find_source_conflict     the passages that push back on a claim
 *   reevaluate_claim         re-check a claim after the user corrected it
 *   select_next_challenge    the next question, grounded in the source
 *   finish_redteam_session   end the review and build the report
 *
 * The ledger write and the Defensibility Map update happen inside
 * evaluate_spoken_claim and reevaluate_claim: the map on screen is a rendering
 * of the ledger, so there is no separate "update the map" call to forget.
 */

export const TOOL_NAMES = [
  "retrieve_source",
  "evaluate_spoken_claim",
  "find_source_conflict",
  "reevaluate_claim",
  "select_next_challenge",
  "finish_redteam_session",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const text = (max: number) => z.string().min(1).max(max);
const passageIds = z.array(z.string().min(1).max(80)).max(10);

export const ARGS = {
  retrieve_source: z.object({ query: text(300) }).strict(),
  evaluate_spoken_claim: z
    .object({
      spoken_text: text(MAX_CLAIM_CHARS),
      normalized_claim: text(MAX_CLAIM_CHARS).optional(),
      passage_ids: passageIds.optional(),
    })
    .strict(),
  find_source_conflict: z.object({ claim_id: text(80) }).strict(),
  reevaluate_claim: z.object({ claim_id: text(80), corrected_text: text(MAX_CLAIM_CHARS) }).strict(),
  select_next_challenge: z.object({}).strict(),
  finish_redteam_session: z.object({}).strict(),
} as const;

type Def = {
  type: "function";
  name: ToolName;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
};

const str = (description: string) => ({ type: "string", description });

export const TOOL_DEFS: Def[] = [
  {
    type: "function",
    name: "retrieve_source",
    description: "Look up passages in the user's document about a topic. Returns quotable text with passage ids. Use it to answer a question about what the document says.",
    parameters: { type: "object", properties: { query: str("A short topic phrase.") }, required: ["query"] },
  },
  {
    type: "function",
    name: "evaluate_spoken_claim",
    description:
      "Record a factual claim the user just made about their document and have the document judge it. Returns SUPPORTED, PARTIAL, CONTRADICTED, UNSUPPORTED or UNRESOLVED with the passages that decided it. Call this after every factual claim, before you say anything about it.",
    parameters: {
      type: "object",
      properties: {
        spoken_text: str("The user's own words, as close to verbatim as you heard them."),
        normalized_claim: str("Optional: the same claim as one clean sentence. Add nothing the user did not say."),
        passage_ids: { type: "array", items: { type: "string" }, description: "Optional passage ids a tool already gave you. Unknown ids are refused." },
      },
      required: ["spoken_text"],
    },
  },
  {
    type: "function",
    name: "find_source_conflict",
    description: "For a claim already recorded, return the passages that contradict it, so you can read one aloud and name its section.",
    parameters: { type: "object", properties: { claim_id: str("The claim_id from evaluate_spoken_claim.") }, required: ["claim_id"] },
  },
  {
    type: "function",
    name: "reevaluate_claim",
    description:
      "The user corrected or clarified a claim, usually after interrupting you. Re-check it against the document from scratch and report whether the verdict changed.",
    parameters: {
      type: "object",
      properties: { claim_id: str("The claim being corrected."), corrected_text: str("The user's correction, in their words.") },
      required: ["claim_id", "corrected_text"],
    },
  },
  {
    type: "function",
    name: "select_next_challenge",
    description: "Get the next question to ask, grounded in the document and in what the user has already claimed. Ask it in your own words.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "finish_redteam_session",
    description: "End the review when the user says they are done. Builds the Defensibility Report on screen.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/**
 * `execution_mode: "hold"` is required by the live service and is the only
 * value it accepts (measured 2026-09-28: every other spelling, including the
 * documented "conversational", and its omission, are rejected with
 * invalid_value at the handshake). It also fits: the agent waits for the
 * document's answer instead of speaking over it.
 */
export function toolDefsForWire(): (Def & { execution_mode: "hold" })[] {
  return TOOL_DEFS.map((d) => ({ ...d, execution_mode: "hold" as const }));
}

export function isToolName(name: unknown): name is ToolName {
  return typeof name === "string" && (TOOL_NAMES as readonly string[]).includes(name);
}

export type ToolOutcome = { result: Record<string, unknown>; isError: boolean };

function claimView(s: RedteamSession, c: Claim) {
  return {
    claim_id: c.id,
    claim: c.normalizedClaim,
    status: c.status,
    basis: c.basis,
    confidence: c.confidence,
    supporting_passages: passagesOf(s, c.evidencePassageIds).map(fmt),
    contradicting_passages: passagesOf(s, c.contradictionPassageIds).map(fmt),
    parts: c.parts.map((p) => ({ text: p.text, status: p.status, note: p.note })),
  };
}

const fmt = (h: ReturnType<typeof hitOf>) => ({ passage_id: h.passageId, section: h.section, text: h.text });

function sayFor(c: Claim, s: RedteamSession, previous: Claim["status"] | null): string {
  const first = (ids: string[]) => passagesOf(s, ids)[0];
  switch (c.status) {
    case "CONTRADICTED": {
      const p = first(c.contradictionPassageIds);
      return `The document contradicts this. Say so first, then read: "${p?.text}" and name the section "${p?.section}".`;
    }
    case "SUPPORTED": {
      const p = first(c.evidencePassageIds);
      return previous && previous !== "SUPPORTED"
        ? `The verdict changed from ${previous} to SUPPORTED. Say that plainly, then read: "${p?.text}" from "${p?.section}".`
        : `The document supports this. Confirm in one sentence and cite "${p?.section}".`;
    }
    case "PARTIAL": {
      const gap = c.parts.find((x) => x.status !== "SUPPORTED");
      return `Only part is backed${gap ? `; there is no backing for "${gap.text}"` : ""}. Say which part the document covers and which it does not.`;
    }
    case "UNSUPPORTED":
      return "Say exactly: I can't find that in the supplied material. Do not guess or answer from general knowledge.";
    default:
      return "There is not enough here to judge. Ask the user to state the claim as a plain sentence.";
  }
}

function fail(message: string): ToolOutcome {
  return { result: { ok: false, error: message, say: message }, isError: true };
}

/**
 * Run one tool call. Never throws: a bad call is an error result the agent
 * can say out loud, not a dead session.
 *
 * Returns `changed` so the route knows whether to persist.
 */
export function runTool(s: RedteamSession, name: unknown, rawArgs: unknown): ToolOutcome & { changed: boolean } {
  if (!isToolName(name)) {
    return { ...fail(`I do not have a tool called ${String(name).slice(0, 40)}.`), changed: false };
  }
  if (s.status === "ended") return { ...fail("This review has ended."), changed: false };
  const args = ARGS[name].safeParse(rawArgs ?? {});
  if (!args.success) {
    return { ...fail(`That call was malformed: ${args.error.issues[0]?.path.join(".") || "input"} ${args.error.issues[0]?.message ?? "is invalid"}.`), changed: false };
  }
  const a = args.data as Record<string, unknown>;

  try {
    switch (name) {
      case "retrieve_source": {
        const hits = searchSource(s, a.query);
        return {
          result: hits.length
            ? { ok: true, found: true, passages: hits.map(fmt), say: "Quote only from these passages, and name their sections." }
            : { ok: true, found: false, passages: [], say: "I can't find that in the supplied material." },
          isError: false,
          changed: false,
        };
      }
      case "evaluate_spoken_claim": {
        const out = recordSpokenClaim(s, {
          spoken: a.spoken_text,
          normalized: (a.normalized_claim as string | undefined) ?? null,
          passageHints: a.passage_ids,
        });
        return {
          result: {
            ok: true,
            corrected_existing_claim: out.corrected,
            previous_status: out.previousStatus,
            ...claimView(s, out.claim),
            map_updated: true,
            say: sayFor(out.claim, s, out.previousStatus),
          },
          isError: false,
          changed: true,
        };
      }
      case "find_source_conflict": {
        const c = s.claims.find((x) => x.id === a.claim_id);
        if (!c) return { ...fail("There is no such claim in this review."), changed: false };
        const ps = passagesOf(s, c.contradictionPassageIds);
        return {
          result: ps.length
            ? { ok: true, claim_id: c.id, conflicts: ps.map(fmt), say: `Read the conflicting text and name its section "${ps[0].section}".` }
            : { ok: true, claim_id: c.id, conflicts: [], say: "The document does not contradict this claim. Do not say that it does." },
          isError: false,
          changed: false,
        };
      }
      case "reevaluate_claim": {
        const out = reevaluateClaim(s, { claimId: a.claim_id, correctedClaim: a.corrected_text });
        return {
          result: {
            ok: true,
            status_changed: out.previousStatus !== out.claim.status,
            previous_status: out.previousStatus,
            ...claimView(s, out.claim),
            map_updated: true,
            say: sayFor(out.claim, s, out.previousStatus),
          },
          isError: false,
          changed: out.corrected,
        };
      }
      case "select_next_challenge": {
        const c = askNext(s);
        return {
          result: {
            ok: true,
            kind: c.kind,
            question: c.question,
            grounded_in: passagesOf(s, c.groundedIn).map(fmt),
            say: `Ask this in your own words, keeping its substance: ${c.question}`,
          },
          isError: false,
          changed: true,
        };
      }
      case "finish_redteam_session": {
        const report = finish(s);
        return {
          result: {
            ok: true,
            counts: report.counts,
            say: "The review is over and the Defensibility Report is on screen. Say so in one sentence. Do not read the report aloud.",
          },
          isError: false,
          changed: true,
        };
      }
    }
  } catch (e) {
    if (e instanceof RedteamError) return { ...fail(e.message), changed: false };
    return { ...fail("That check could not be run."), changed: false };
  }
}

export { markInterrupted, publicView };
