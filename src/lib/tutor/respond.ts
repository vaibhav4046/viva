import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { Course, ExamQuestion } from "@/lib/courses";
import type { LearningEvent, LearningIntent, SourceChunk } from "@/lib/types";
import type { CompileDraft } from "@/lib/compiler";
import { IntentConfirmSchema, TutorReplySchema, type TurnIntent, type TutorReply } from "./schema";
import { UNCHECKED_LEAD, tutorRespond } from "./heuristic";

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
  /** The learner asked to leave the open question. */
  stopped: boolean;
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
  hint: "hint",
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
  // Asking for a nudge is not a wrong answer and must not cost anything: the
  // reducer has no case for `hint`, so it falls through unchanged. A product
  // built on students admitting they are stuck cannot charge them for saying
  // so — and the note log labels it as the process turn it is rather than
  // filing it against a passage as a claim.
  hint: "hint",
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
 * How many graded attempts one question gets before VIVA closes it and moves
 * on. Without a ceiling a question the learner abandoned stays open forever
 * and swallows every later sentence.
 */
export const MAX_ATTEMPTS = 3;

/** "Stop" in the words people actually use. */
const STOP_RE = /^\s*(stop|cancel|skip|next question|new question|never\s?mind|forget it|move on|i'?m done|done|no more)\b/i;

/** "I'm stuck" in the words people actually use. */
export const HINT_RE = /\b(hint|clue|stuck|nudge|give me a start|help me out|i give up|no idea)\b/i;

export type OpenState = {
  question: ExamQuestion | null;
  /** Graded attempts on it so far. */
  attempts: number;
  /** Nudges already asked for on it. */
  hintsUsed: number;
};

/**
 * Is a question still open?
 *
 * A question opens when a turn asks one — "quiz me", or a caught claim — and
 * stays open until the learner clears it, says stop, or runs out of attempts.
 * It used to be "was the single previous turn a quiz request", which meant a
 * student got exactly one attempt ever: answer it wrong and the question froze
 * with the wrong answer recorded, with no way to fix it.
 */
export function openStateFrom(events: LearningEvent[], course: Course): OpenState {
  let asked = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.assessment === "correct" || STOP_RE.test(e.cleanedTranscript)) return { question: null, attempts: 0, hintsUsed: 0 };
    if (e.requestedAction === "quiz") { asked = i; break; }
  }
  if (asked === -1) return { question: null, attempts: 0, hintsUsed: 0 };
  const since = events.slice(asked + 1);
  const attempts = since.filter((e) => e.assessment != null).length;
  const hintsUsed = since.filter((e) => HINT_RE.test(e.cleanedTranscript)).length;
  if (attempts >= MAX_ATTEMPTS) return { question: null, attempts, hintsUsed };
  return { question: quizQuestionFor(course, events[asked].primaryConceptId) ?? null, attempts, hintsUsed };
}

/**
 * Replay the last 6 exchanges for this subject, and work out whether a
 * question is still open (see `openStateFrom`).
 */
export function readHistory(events: LearningEvent[], course: Course): { memory: TurnMemory[]; openQuestion: ExamQuestion | null; open: OpenState } {
  const mine = events.filter((e) => (e.courseId ?? course.id) === course.id);
  const memory = mine.slice(-6).map<TurnMemory>((e) => {
    const intent = INTENT_MAP[e.intent] ?? "note";
    return {
      intent,
      conceptId: e.primaryConceptId,
      question: e.requestedAction === "quiz" ? quizQuestionFor(course, e.primaryConceptId)?.question ?? null : null,
      said: e.cleanedTranscript.slice(0, 240),
    };
  });
  const open = openStateFrom(mine, course);
  return { memory, openQuestion: open.question, open };
}

/**
 * A verb whitelist used to stand here (is|are|means|…), which meant a sentence
 * built on any other verb — "multi-head attention USES one head per layer" —
 * never reached the claim checker and was filed as a note instead. The general
 * rule runs the other way: a full sentence that is not asking for something is
 * a position the learner is taking, whatever verb it happens to use.
 */
const DECLARATIVE = /[a-z]/i;
/**
 * Anything that makes the sentence a request rather than a position.
 *
 * The bare question words are anchored to the start. Loose, they matched
 * mid-sentence — "attention weights already encode WHICH words are important"
 * read as a question, so the subject's own listed misconception about order vs
 * importance was filed unchecked. A request phrase can appear anywhere; a
 * question word in the middle of a statement is just English.
 */
const ASKING = /\?|\b(explain|eli5|clarify|tell me|help me|can you|quiz|test me|difference between|versus)\b|^\s*\W*(what|why|how|who|which|when|where|is|are|does|do|can|could|should)\b/i;

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
    DECLARATIVE.test(draft.cleanedTranscript) &&
    !ASKING.test(draft.cleanedTranscript) &&
    draft.cleanedTranscript.split(/\s+/).length >= 5;
  if (declarative && (intent === "note" || intent === "explain")) intent = "claim";
  // A question is open: every sentence belongs to it until the learner clears
  // it or says stop. Asking for a nudge is neither an answer nor a note.
  let stopped = false;
  if (openQuestion) {
    if (STOP_RE.test(draft.cleanedTranscript)) { intent = "note"; stopped = true; }
    else if (HINT_RE.test(draft.cleanedTranscript)) intent = "hint";
    else if (intent !== "quiz") intent = "answer";
  }

  let conceptIds = draft.conceptIds;
  let inherited = false;
  if (conceptIds.length === 0) {
    const carried = openQuestion?.conceptId ?? [...history].reverse().find((t) => t.conceptId)?.conceptId ?? null;
    if (carried) {
      conceptIds = [carried];
      inherited = true;
    }
  }
  return { intent, conceptIds, primaryConceptId: conceptIds[0] ?? null, openQuestion, inherited, stopped };
}

export const INTENT_SYSTEM = [
  "You label one thing a learner just said while studying.",
  // `hint` was described on the next line but missing from this enum, so the
  // one intent the schema accepts and the prompt hid was the one a stuck
  // learner needs. The schema is the list; the prompt now says the same list.
  'Reply ONLY as one JSON object with EXACTLY these two keys: {"intent": one of confused|claim|explain|quiz|teach|answer|hint|note, "conceptIds": [ids from the list given]}.',
  "confused = they say they do not get it. claim = they state what they believe. explain = they ask for an explanation.",
  "quiz = they ask to be tested. teach = they are explaining it back. answer = they are answering the open question. hint = they are stuck and want a nudge. note = anything else worth keeping.",
  "Use only concept ids from the list. If they say 'it' or 'that', use the concept from the previous turn.",
].join(" ");

/**
 * Let the model confirm the first pass. The first pass wins whenever the model
 * is unavailable, and always for `answer`: a question is open or it is not, and
 * that is not a judgement call.
 *
 * With a question open there is nothing left for this call to decide, so it is
 * not made. The intent it returns is discarded two lines down (`plan.intent`
 * wins), and the only other thing it can do is replace the concept the open
 * question already fixed with a guess — worse on both counts. It also costs a
 * round trip on the one turn that needs its budget for grading the answer:
 * the live provider allows 8,000 tokens a minute (measured), one turn spends
 * roughly a thousand per model call, and every turn was making two. When that
 * ceiling is hit the provider answers 429 and the learner silently gets the
 * heuristic — so a call that cannot change the outcome is not free, it is a
 * call that pushes a later real one over the line.
 */
export async function confirmPlan(plan: TurnPlan, opts: { text: string; course: Course; history: TurnMemory[] }): Promise<TurnPlan> {
  if (plan.openQuestion) return plan;
  const known = new Set(opts.course.concepts.map((c) => c.id));
  const result = await reasonObject({
    system: INTENT_SYSTEM,
    user: [
      `Subject: ${opts.course.title}`,
      `Concept ids: ${opts.course.concepts.map((c) => `${c.id} (${c.name})`).join(", ")}`,
      `Previous turns:\n${historyBlock(opts.history)}`,
      // Always none: the guard above returns before this when one is open.
      "Open question: none",
      `They just said: ${opts.text}`,
      `First reading: ${plan.intent}${plan.primaryConceptId ? ` about ${plan.primaryConceptId}` : ""}`,
    ].join("\n\n"),
    schema: IntentConfirmSchema,
    timeoutMs: REASON_TIMEOUT_MS.tutor,
  });
  if (!result) return plan;

  const conceptIds = result.value.conceptIds.filter((id) => known.has(id));
  const merged = conceptIds.length > 0 ? conceptIds : plan.conceptIds;
  return { ...plan, intent: result.value.intent, conceptIds: merged, primaryConceptId: merged[0] ?? null };
}

function historyBlock(history: TurnMemory[]): string {
  if (history.length === 0) return "(none yet)";
  return history
    .map((t) => `- ${t.intent}${t.conceptId ? ` [${t.conceptId}]` : ""}: "${t.said}"${t.question ? ` → VIVA asked: "${t.question}"` : ""}`)
    .join("\n");
}

/*
 * The keys are spelled out because "Reply ONLY as the JSON schema" does not
 * tell a model what the schema IS.
 *
 * Measured against the live provider (Groq, openai/gpt-oss-120b): the old
 * prompt came back `{"wrong":…,"correction":…,"citation":[…],"question":…}` —
 * sensible content under invented key names — which failed the parse, failed
 * the one repair retry, and dropped every tutor turn to the heuristic path.
 * Three model turns in a row, three silent downgrades. The two prompts that
 * already listed their keys (intent, assessment) were the two that worked, so
 * this is the difference, not the model. With the keys named, three of three
 * probes parsed first time.
 */
export const TUTOR_SYSTEM = [
  "You are VIVA, a Socratic study partner.",
  "Reply ONLY as one JSON object with EXACTLY these seven keys, every one of them present every time:",
  '{"right": string or null, "wrong": string or null, "question": string or null,',
  ' "citations": [{"chunkId": string, "quote": string}],',
  ' "misconception": string or null, "masterySignal": "up" | "down" | "flat",',
  ' "strategy": "probe" | "contrast" | "analogy" | "recall" | "teachback"}',
  "right = what they got right, or null. Put something there ONLY if they actually said it — never credit them for a thing you inferred they must know. \"Explain it simply\" is a request, not an answer, so right is null.",
  "wrong = what is wrong or missing, one line, or null. question = the single question you ask them.",
  "citations = at most 2, each chunkId copied exactly from the passage ids given, each quote at most 160 characters taken from that passage.",
  "misconception = the mistaken belief in one line, or null. masterySignal = up if they showed they know it, down if they got it wrong, flat if you could not tell.",
  "Rules: at most 90 words across right, wrong and question; confirm only what a given passage actually shows, and if none of them settles it say you could not check it rather than implying the source agrees;",
  "ask exactly one question that makes the learner do the thinking (never answer it yourself); speak TO the learner as \"you\", never about them as \"they\"; plain English, no course codes, no praise words like \"great job\";",
  "if the passages do not support a correction, set wrong to null and ask a question that would reveal the gap. Never invent citations: every chunkId must be one of the ids given.",
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
  /**
   * The claim check ran on these words and came back with nothing either way.
   * Not caught is not agreed with, so the reply says so out loud rather than
   * letting the model fill the silence with encouragement.
   */
  unchecked?: boolean;
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
  // Nothing was caught and nothing was confirmed: say which, in the same words
  // the heuristic branch uses, so a learner gets one answer either way. A
  // reply that corrects something is not an affirmation and needs no lead.
  const composed = composeReply(reply);
  // Blank-but-present is the shape the live provider actually sends for "no
  // correction", and `!reply.wrong` reads a single space as a correction.
  const corrected = Boolean(reply.wrong && reply.wrong.trim());
  const text = opts.unchecked && !corrected ? `${UNCHECKED_LEAD} ${composed}`.trim() : composed;
  return { reply, text, citedIds: reply.citations.map((c) => c.chunkId), source: "model", latencyMs: result.latencyMs };
}

/**
 * Master prompt 5.2: a citation survives only if its id is in the retrieved
 * set. If a correction loses its last citation, the correction goes with it —
 * VIVA says it cannot find it rather than asserting it anyway.
 *
 * `right` is deleted unless the caller says something actually verified the
 * learner's sentence, and nothing on this path does: the only check that can
 * confirm a claim is `checkClaim`, and it never reaches the model. Left in, the
 * field is the model echoing the learner's own words back as VIVA's line —
 * measured, and on a false claim about the learner's own module that is the
 * app teaching them the wrong thing in its own voice.
 */
export function groundReply(
  reply: TutorReply,
  chunks: SourceChunk[],
  opts: { mayAffirm?: boolean } = {}
): TutorReply {
  const known = new Set(chunks.map((c) => c.id));
  const citations = reply.citations.filter((c) => known.has(c.chunkId));
  const right = opts.mayAffirm ? reply.right : null;
  if (citations.length > 0 || !reply.wrong) return { ...reply, right, citations };
  return { ...reply, right, citations, wrong: NO_SOURCE_LINE, misconception: null };
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
