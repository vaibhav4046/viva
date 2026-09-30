import { selectDailyPath, conceptNamer, type PathSegmentOut } from "@/lib/planner";
import { quoteSpans } from "./verify-claim";
import type { ConceptMastery, LearningEvent, SourceChunk } from "@/lib/types";

/**
 * The debrief: a summary of one oral exam built only from what the exam
 * recorded, and tomorrow's plan from the same planner the Today screen uses.
 *
 * Nothing here calls a model. Each line is a verdict that a tool returned in the
 * session, and each citation is re-checked against the passages here, so a
 * record that was edited or forged in the browser cannot put a quote on the
 * sheet that the material does not contain.
 */

export type Verdict = "supported" | "contradicted" | "not_in_material";
export type Grade = "correct" | "partial" | "incorrect";

export type ClaimEntry = {
  kind: "claim";
  conceptId: string | null;
  learner: string;
  verdict: Verdict;
  quote: string | null;
  page: number | null;
  passageId: string | null;
};
export type AnswerEntry = {
  kind: "answer";
  conceptId: string | null;
  learner: string;
  grade: Grade;
};
export type SessionEntry = ClaimEntry | AnswerEntry;

/** The recorded session the debrief is built from (also the fixture format). */
export type SessionRecord = {
  sessionId: string;
  /** ISO time the exam started. */
  startedAt: string;
  userTurns: number;
  interruptions: number;
  entries: SessionEntry[];
};

export type Standing = "strong" | "shaky" | "weak";

export type ConceptStanding = {
  conceptId: string;
  name: string;
  standing: Standing;
  /** Turn evidence, oldest first. Learner words are short quotes; page comes from a verified citation. */
  evidence: { learner: string; result: string; page: number | null }[];
};

export type CaughtMisconception = {
  conceptId: string | null;
  conceptName: string | null;
  learnerSaid: string;
  material: { quote: string; page: number | null };
};

export type Debrief = {
  sessionId: string;
  generatedAt: string;
  turns: number;
  interruptions: number;
  concepts: ConceptStanding[];
  misconceptions: CaughtMisconception[];
  plan: { totalMinutes: number; steps: (PathSegmentOut & { order: number })[] };
  /** Entries whose citation failed re-verification and were kept without one. */
  citationsDropped: number;
  /** Set by the route: whether the learner store behind this survives a restart. */
  storage?: { durable: boolean; note: string };
};

/** The planner's copy uses long dashes; the sheet does not. */
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const plain = (text: string) => text.split(" " + EM + " ").join(", ").split(" " + EN + " ").join(", ").split(EM).join(", ").split(EN).join("-");

const SNIPPET = 140;
const snippet = (text: string) => (text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1).trimEnd()}...` : text);

/** A concept id from a spoken name or from the claim itself: id, name, then alias. */
export function resolveConceptId(
  concepts: { id: string; name: string; aliases?: string[] }[],
  ...texts: (string | undefined | null)[]
): string | null {
  for (const raw of texts) {
    const text = (raw ?? "").toLowerCase().trim();
    if (!text) continue;
    const exact = concepts.find((c) => c.id.toLowerCase() === text || c.name.toLowerCase() === text);
    if (exact) return exact.id;
    let best: { id: string; len: number } | null = null;
    for (const c of concepts) {
      for (const term of [c.name, ...(c.aliases ?? [])]) {
        const t = term.toLowerCase();
        if (t.length >= 4 && text.includes(t) && (!best || t.length > best.len)) best = { id: c.id, len: t.length };
      }
    }
    if (best) return best.id;
  }
  return null;
}

type Signal = "up" | "down" | "flat";
const signalOf = (e: SessionEntry): Signal =>
  e.kind === "claim"
    ? e.verdict === "supported" ? "up" : e.verdict === "contradicted" ? "down" : "flat"
    : e.grade === "correct" ? "up" : e.grade === "incorrect" ? "down" : "flat";

/**
 * strong: positives only. weak: the last decisive signal is a miss. shaky:
 * anything else, including a miss that a later answer fixed and answers the
 * material did not settle.
 */
export function standingFor(signals: Signal[]): Standing {
  const decisive = signals.filter((s) => s !== "flat");
  if (decisive.length === 0) return "shaky";
  if (decisive.at(-1) === "down") return "weak";
  return decisive.includes("down") ? "shaky" : "strong";
}

export function buildDebrief(input: {
  record: SessionRecord;
  concepts: { id: string; name: string; aliases?: string[] }[];
  chunks: SourceChunk[];
  /** Mastery AFTER this session, straight from the store: the exam already wrote its verdicts there. */
  mastery: Record<string, ConceptMastery>;
  /** The learner's recent events from the store; the planner reads unresolved misconceptions from them. */
  events: LearningEvent[];
  now: Date;
}): Debrief {
  const { record, concepts, chunks, mastery } = input;
  const nameOf = conceptNamer(concepts);
  let dropped = 0;

  // Re-verify every citation. A quote that is not verbatim in its passage is removed, not trusted.
  const verified = record.entries.map((entry) => {
    if (entry.kind !== "claim" || entry.verdict === "not_in_material") return entry;
    const passage = chunks.find((c) => c.id === entry.passageId);
    const ok = passage && entry.quote && quoteSpans(entry.quote, passage.text) !== null;
    if (ok) return { ...entry, page: passage.locator.page ?? null };
    dropped += 1;
    return { ...entry, verdict: "not_in_material" as const, quote: null, page: null, passageId: null };
  });

  // A conceptId from the browser may be a spoken concept name (verify_claim passes the name the agent used), so resolve it first, then the learner's own words.
  const resolved = verified.map((e) => ({ ...e, conceptId: resolveConceptId(concepts, e.conceptId, e.learner) }));
  const byConcept = new Map<string, SessionEntry[]>();
  for (const entry of resolved) {
    if (!entry.conceptId) continue;
    byConcept.set(entry.conceptId, [...(byConcept.get(entry.conceptId) ?? []), entry]);
  }

  const standings: ConceptStanding[] = [...byConcept.entries()].map(([conceptId, entries]) => ({
    conceptId,
    name: nameOf(conceptId),
    standing: standingFor(entries.map(signalOf)),
    evidence: entries.map((e) => ({
      learner: snippet(e.learner),
      result:
        e.kind === "claim"
          ? e.verdict === "supported" ? "the material supports it" : e.verdict === "contradicted" ? "the material says otherwise" : "the material does not settle it"
          : e.grade === "correct" ? "answered correctly" : e.grade === "partial" ? "partly right" : "answered incorrectly",
      page: e.kind === "claim" ? e.page : null,
    })),
  }));
  const rank: Record<Standing, number> = { weak: 0, shaky: 1, strong: 2 };
  standings.sort((a, b) => rank[a.standing] - rank[b.standing]);

  const misconceptions: CaughtMisconception[] = resolved.flatMap((e) =>
    e.kind === "claim" && e.verdict === "contradicted" && e.quote
      ? [{
          conceptId: e.conceptId,
          conceptName: e.conceptId ? nameOf(e.conceptId) : null,
          learnerSaid: snippet(e.learner),
          material: { quote: e.quote, page: e.page },
        }]
      : []
  );

  // Tomorrow's plan is the Today planner run on the mastery the exam just wrote.
  const path = selectDailyPath({ mastery, events: input.events, queue: [], concepts });
  const steps = path.map((s, i) => ({ ...s, why: plain(s.why), order: i + 1 }));

  return {
    sessionId: record.sessionId,
    generatedAt: input.now.toISOString(),
    turns: record.userTurns,
    interruptions: record.interruptions,
    concepts: standings,
    misconceptions,
    plan: { totalMinutes: steps.reduce((n, s) => n + s.minutes, 0), steps },
    citationsDropped: dropped,
  };
}

/** Plain text for the printable sheet, so the print view and the tests read the same words. */
export function debriefToText(d: Debrief): string {
  const lines: string[] = [`Oral exam debrief, ${d.generatedAt.slice(0, 10)}`, `${d.turns} answers, ${d.interruptions} interruptions`, ""];
  for (const c of d.concepts) {
    lines.push(`${c.name}: ${c.standing}`);
    for (const e of c.evidence) lines.push(`  "${e.learner}" (${e.result}${e.page != null ? `, page ${e.page}` : ""})`);
  }
  if (d.misconceptions.length) {
    lines.push("", "Caught against your material:");
    for (const m of d.misconceptions) lines.push(`  You said: "${m.learnerSaid}". The material: "${m.material.quote}"${m.material.page != null ? ` (page ${m.material.page})` : ""}`);
  }
  lines.push("", `Tomorrow, ${d.plan.totalMinutes} minutes:`);
  for (const s of d.plan.steps) lines.push(`  ${s.order}. ${s.conceptName ?? "Write it down"} (${s.minutes} min): ${s.why}`);
  if (d.storage && !d.storage.durable) lines.push("", d.storage.note);
  return lines.join("\n");
}
