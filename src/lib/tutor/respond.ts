import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { Course, ExamQuestion } from "@/lib/courses";
import type { LearningEvent, LearningIntent, SourceChunk } from "@/lib/types";
import type { CompileDraft } from "@/lib/compiler";
import { IntentConfirmSchema, TutorReplySchema, type TurnIntent, type TutorReply } from "./schema";
import { tutorRespond } from "./heuristic";

/** One remembered exchange: what the learner was doing and what VIVA asked. */
export type TurnMemory = {
  intent: TurnIntent;
  conceptId: string | null;
  question: string | null;
  said: string;
};

export type TurnPlan = {
  intent: TurnIntent;
  conceptIds: string[];
  primaryConceptId: string | null;
  openQuestion: ExamQuestion | null;
  /** True when the concept came from an earlier turn, not from these words. */
  inherited: boolean;
};

const INTENT_MAP: Record<LearningIntent, TurnIntent> = {
  confusion: "confused",
  claim: "claim",
  correction: "claim",
  question: "explain",
  explain: "explain",
  compare: "explain",
  quiz_request: "quiz",
  review_request: "quiz",
  teachback: "teach",
  remember: "note",
  exam_marker: "note",
  connection: "note",
  note: "note",
};

/** Back to the persisted vocabulary, so the mastery fold keeps its contract. */
export const LEARNING_INTENT: Record<TurnIntent, LearningIntent> = {
  confused: "confusion",
  claim: "claim",
  explain: "explain",
  quiz: "quiz_request",
  teach: "teachback",
  // A graded answer folds as a claim with a verdict attached — that is the
  // path that moves mastery, and why a spoken answer must never land as a note.
  answer: "claim",
  note: "note",
};

/**
 * The question a quiz turn asks. Picked from the bank, never invented, so the
 * next turn can grade the answer against the same question without persisting
 * extra state.
 */
export function quizQuestionFor(course: Course, conceptId: string | null): ExamQuestion | undefined {
  return course.examQuestions.find((q) => q.conceptId === conceptId) ?? course.examQuestions[0];
}

/**
 * Replay the last 6 exchanges for this subject. An open question is one the
 * most recent turn asked and nothing has answered yet.
 */
export function readHistory(events: LearningEvent[], course: Course): { memory: TurnMemory[]; openQuestion: ExamQuestion | null } {
  const mine = events.filter((e) => (e.courseId ?? course.id) === course.id);
  const memory = mine.slice(-6).map<TurnMemory>((e) => {
    const intent = INTENT_MAP[e.intent] ?? "note";
    return {
      intent,
      conceptId: e.primaryConceptId,
      question: intent === "quiz" ? quizQuestionFor(course, e.primaryConceptId)?.question ?? null : null,
      said: e.cleanedTranscript.slice(0, 240),
    };
  });
  const last = memory[memory.length - 1];
  const openQuestion = last?.intent === "quiz" ? quizQuestionFor(course, last.conceptId) ?? null : null;
  return { memory, openQuestion };
}

const DECLARATIVE = /\b(is|are|was|were|means|happens|works|does|do|has|have|equals|when|because)\b/i;
/** Anything that makes the sentence a request rather than a position. */
const ASKING = /\?|\b(explain|eli5|clarify|what|why|how|who|which|tell me|help me|can you|quiz|test me|difference between|versus)\b/i;

/**
 * First pass, no model needed. Two rules earn their keep here:
 *  - a spoken answer wins while a question is open (the demo climax);
 *  - "explain it simply" with no concept in it inherits the last concept.
 */
export function planTurn(draft: CompileDraft, history: TurnMemory[], openQuestion: ExamQuestion | null): TurnPlan {
  let intent = INTENT_MAP[draft.intent] ?? "note";

  // A full sentence stating something about a concept is a position to check,
  // not a note to file and not a question to answer. "Self-attention is when
  // every token compares itself to every other" reads as a request to compare
  // on keywords alone; it is the learner telling you what they believe.
  const declarative =
    draft.conceptIds.length > 0 &&
    DECLARATIVE.test(draft.cleanedTranscript) &&
    !ASKING.test(draft.cleanedTranscript) &&
    draft.cleanedTranscript.split(/\s+/).length >= 5;
  if (declarative && (intent === "note" || intent === "explain")) intent = "claim";
  // A question is open: these words are the answer to it, unless the learner
  // is explicitly asking for a different question.
  if (openQuestion && intent !== "quiz") intent = "answer";

  let conceptIds = draft.conceptIds;
  let inherited = false;
  if (conceptIds.length === 0) {
    const carried = openQuestion?.conceptId ?? [...history].reverse().find((t) => t.conceptId)?.conceptId ?? null;
    if (carried) {
      conceptIds = [carried];
      inherited = true;
    }
  }
  return { intent, conceptIds, primaryConceptId: conceptIds[0] ?? null, openQuestion, inherited };
}

const INTENT_SYSTEM = [
  "You label one thing a learner just said while studying.",
  'Reply ONLY as JSON: {"intent": one of confused|claim|explain|quiz|teach|answer|note, "conceptIds": ids from the list given}.',
  "confused = they say they do not get it. claim = they state what they believe. explain = they ask for an explanation.",
  "quiz = they ask to be tested. teach = they are explaining it back. answer = they are answering the open question. note = anything else worth keeping.",
  "Use only concept ids from the list. If they say 'it' or 'that', use the concept from the previous turn.",
].join(" ");

/**
 * Let the model confirm the first pass. The first pass wins whenever the model
 * is unavailable, and always for `answer`: a question is open or it is not, and
 * that is not a judgement call.
 */
export async function confirmPlan(plan: TurnPlan, opts: { text: string; course: Course; history: TurnMemory[] }): Promise<TurnPlan> {
  const known = new Set(opts.course.concepts.map((c) => c.id));
  const result = await reasonObject({
    system: INTENT_SYSTEM,
    user: [
      `Subject: ${opts.course.title}`,
      `Concept ids: ${opts.course.concepts.map((c) => `${c.id} (${c.name})`).join(", ")}`,
      `Previous turns:\n${historyBlock(opts.history)}`,
      plan.openQuestion ? `Open question: "${plan.openQuestion.question}"` : "Open question: none",
      `They just said: ${opts.text}`,
      `First reading: ${plan.intent}${plan.primaryConceptId ? ` about ${plan.primaryConceptId}` : ""}`,
    ].join("\n\n"),
    schema: IntentConfirmSchema,
    timeoutMs: REASON_TIMEOUT_MS.tutor,
  });
  if (!result) return plan;

  const conceptIds = result.value.conceptIds.filter((id) => known.has(id));
  const intent = plan.openQuestion ? plan.intent : result.value.intent;
  const merged = conceptIds.length > 0 ? conceptIds : plan.conceptIds;
  return { ...plan, intent, conceptIds: merged, primaryConceptId: merged[0] ?? null };
}

function historyBlock(history: TurnMemory[]): string {
  if (history.length === 0) return "(none yet)";
  return history
    .map((t) => `- ${t.intent}${t.conceptId ? ` [${t.conceptId}]` : ""}: "${t.said}"${t.question ? ` → VIVA asked: "${t.question}"` : ""}`)
    .join("\n");
}

const TUTOR_SYSTEM = [
  'You are VIVA, a Socratic study partner. Reply ONLY as the JSON schema.',
  "Rules: at most 90 words across fields; confirm what is right in one line; name what is wrong or missing in one line and cite the passage id that shows it;",
  "ask exactly one question that makes the learner do the thinking (never answer it yourself); plain English, no course codes, no praise words like \"great job\";",
  "if the passages do not support a correction, set wrong=null and ask a question that would reveal the gap. Never invent citations: every chunkId must be one of the ids given.",
].join(" ");

const NO_SOURCE_LINE = "I can't find that in your source, so here's what I'd check.";

export type TutorTurn = {
  reply: TutorReply;
  text: string;
  citedIds: string[];
  source: "model" | "heuristic";
  latencyMs: number | null;
};

/** Model reply when there is one, heuristic reply when there is not. */
export async function tutorReply(opts: {
  course: Course;
  plan: TurnPlan;
  text: string;
  history: TurnMemory[];
  chunks: SourceChunk[];
  conceptName: string | null;
  mastery?: number;
}): Promise<TutorTurn> {
  const { course, plan, chunks } = opts;

  // A quiz turn asks the bank question verbatim so the next turn can grade it.
  if (plan.intent === "quiz") return heuristicTurn(opts);

  const result = await reasonObject({
    system: TUTOR_SYSTEM,
    user: [
      `Subject: ${course.title}`,
      `Previous turns:\n${historyBlock(opts.history)}`,
      `Intent: ${plan.intent}`,
      `Concept: ${opts.conceptName ?? "unclear"}`,
      `Passages:\n${chunks.length ? chunks.map((c) => `[${c.id}] ${c.text.slice(0, 700)}`).join("\n") : "(none retrieved)"}`,
      `They just said: ${opts.text}`,
    ].join("\n\n"),
    schema: TutorReplySchema,
    timeoutMs: REASON_TIMEOUT_MS.tutor,
  });
  if (!result) return heuristicTurn(opts);

  const reply = groundReply(result.value, chunks);
  return { reply, text: composeReply(reply), citedIds: reply.citations.map((c) => c.chunkId), source: "model", latencyMs: result.latencyMs };
}

/**
 * Master prompt 5.2: a citation survives only if its id is in the retrieved
 * set. If a correction loses its last citation, the correction goes with it —
 * VIVA says it cannot find it rather than asserting it anyway.
 */
export function groundReply(reply: TutorReply, chunks: SourceChunk[]): TutorReply {
  const known = new Set(chunks.map((c) => c.id));
  const citations = reply.citations.filter((c) => known.has(c.chunkId));
  if (citations.length > 0 || !reply.wrong) return { ...reply, citations };
  return { ...reply, citations, wrong: NO_SOURCE_LINE, misconception: null };
}

/** At most three parts, 90 words. Drops the praise line first when over. */
export function composeReply(reply: TutorReply): string {
  const join = (parts: (string | null)[]) => parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").trim();
  const full = join([reply.right, reply.wrong, reply.question]);
  if (countWords(full) <= 90) return full;
  const trimmed = join([reply.wrong, reply.question]);
  if (countWords(trimmed) <= 90) return trimmed;
  return trimmed.split(/\s+/).slice(0, 90).join(" ");
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function heuristicTurn(opts: {
  course: Course;
  plan: TurnPlan;
  text: string;
  chunks: SourceChunk[];
  conceptName: string | null;
  mastery?: number;
}): TutorTurn {
  const { plan, chunks } = opts;
  const evidenceIds = chunks.map((c) => c.id);
  const t = tutorRespond({
    intent: legacyIntentFor(plan.intent),
    cleanedTranscript: opts.text,
    conceptName: opts.conceptName,
    conceptId: plan.primaryConceptId,
    evidenceIds,
    mastery: opts.mastery,
    course: opts.course,
  });
  const question = /\?/.test(t.text) ? t.text.slice(0, 200) : null;
  const reply: TutorReply = {
    right: null,
    wrong: null,
    question,
    citations: chunks.slice(0, 2).map((c) => ({ chunkId: c.id, quote: c.text.slice(0, 160) })),
    misconception: null,
    masterySignal: plan.intent === "confused" ? "down" : "flat",
    strategy: plan.intent === "quiz" ? "recall" : plan.intent === "teach" ? "teachback" : plan.intent === "explain" ? "analogy" : "probe",
  };
  return { reply, text: t.text, citedIds: reply.citations.map((c) => c.chunkId), source: "heuristic", latencyMs: null };
}

/** The heuristic tutor speaks the older intent vocabulary. */
function legacyIntentFor(intent: TurnIntent): string {
  return LEARNING_INTENT[intent];
}
