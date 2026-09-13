import { z } from "zod";
import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { ConceptDef, ExamQuestion, Explainer, Trap } from "@/lib/courses/types";
import { clip } from "@/lib/tutor/schema";

/**
 * The model path (Master prompt §6 step 2).
 *
 * The model reads the learner's passages and writes the map: concepts, exam
 * questions, two explanations per concept, the traps worth warning about, and
 * the recognition terms the dictation call biases towards. Everything is
 * schema-validated; the provider itself makes one repair attempt, and a second
 * failure returns null so the caller can read the notes itself instead.
 */

/**
 * Every count the map has to satisfy, written once.
 *
 * The schema enforces these numbers and `PLAN_SHAPE` quotes them into the
 * prompt, so what the model is told cannot drift from what the validator
 * accepts. The drift is not hypothetical. Measured against the live provider
 * with the old prompt, which said only "matching the schema you are given":
 * both source texts probed came back with every question, explanation and trap
 * nested inside its own concept and no `title`, `subject`, `examQuestions`,
 * `explainers`, `traps`, `teachback` or `keyterms` key anywhere — real subject
 * matter, invented structure, thrown away whole. Same failure the tutor reply
 * had (see the note above TUTOR_SYSTEM), same fix.
 */
const N = {
  concepts: { min: 6, max: 10 },
  aliases: { min: 1, max: 8 },
  related: { max: 4 },
  examQuestions: { min: 5, max: 8 },
  requiredKeywords: { min: 3, max: 6 },
  missing: { max: 4 },
  traps: { min: 2, max: 4 },
  teachbackKeywords: { max: 8 },
  keyterms: { max: 60 },
  passages: { min: 8, max: 12 },
  passageChars: { min: 120, max: 1200 },
} as const;

/** An id has to resolve, so it is never clipped and never repaired — only dropped. */
const ID_RE = /^[a-z0-9_]+$/;
const Id = z.string().min(2).max(60).regex(ID_RE);

/**
 * A maximum on prose is a display budget, so it clips — the same call the
 * tutor's reply makes, for the same measured reason: a six-character overrun
 * should cost a few characters, not a whole grounded map. A minimum is not a
 * budget. A two-word description is not a short description, it is a missing
 * one, so minimums still refuse.
 */
const text = (min: number, max: number) => z.string().min(min).transform((s) => clip(s, max));

/** A list over its ceiling is trimmed to it; a list under its floor still refuses. */
const list = <T extends z.ZodTypeAny>(item: T, bounds: { min?: number; max: number }) =>
  (bounds.min ? z.array(item).min(bounds.min) : z.array(item)).transform((a) => a.slice(0, bounds.max));

const Alias = text(2, 50);
const Keyword = text(2, 40);
const Keyterm = text(2, 50);

const ConceptShape = z.object({
  id: Id,
  name: text(2, 70),
  aliases: list(Alias, N.aliases),
  description: text(10, 400),
  related: list(Id, N.related),
});
const QuestionShape = z.object({
  conceptId: Id,
  question: text(10, 220),
  requiredKeywords: list(Keyword, N.requiredKeywords),
  hint: text(5, 240),
});
const ExplainerShape = z.object({
  formal: text(20, 700),
  jargonFree: text(20, 700),
  missing: list(text(0, 160), N.missing),
});
const TrapShape = z.object({
  conceptId: Id,
  statement: text(10, 300),
  whyWrong: text(10, 500),
  correct: text(5, 300),
});

const PlanShape = z.object({
  title: text(2, 90),
  subject: text(2, 60),
  concepts: list(ConceptShape, N.concepts),
  examQuestions: list(QuestionShape, N.examQuestions),
  explainers: z.record(Id, ExplainerShape),
  traps: list(TrapShape, N.traps),
  teachback: z.object({
    keywords: z.record(Id, list(Keyword, N.teachbackKeywords)),
    hints: z.record(Id, text(0, 240)),
  }),
  keyterms: list(Keyterm, N.keyterms),
});

export type SubjectPlan = z.infer<typeof PlanShape>;
/**
 * The repair runs inside the schema, so it runs inside the provider's own
 * parse and inside its repair retry too — the caller never sees raw output, so
 * this is the only place it can run. `z.preprocess` types its input as
 * `unknown`, which is exactly right at runtime (the input IS unknown JSON) and
 * does not fit the `ZodType<T>` the reasoning seam asks for; hence the
 * assertion, which changes nothing about what is validated.
 */
export const SubjectPlanSchema = z.preprocess(repairPlan, PlanShape) as unknown as z.ZodType<SubjectPlan>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const strings = (v: unknown): string[] =>
  asArray(v).filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
/** Keep the items the schema would accept, in the form the model wrote them. */
const keepValid = (items: unknown[], shape: z.ZodTypeAny): unknown[] =>
  items.filter((item) => shape.safeParse(item).success);

/**
 * Subtractive repair, run before validation: drop what cannot pass, never
 * invent what is missing.
 *
 * The seeding script proved the rule against a smaller model. Models slip on
 * the countable parts — a question with two required keywords where three are
 * asked for, a `related` key left off entirely — and Zod then threw a whole
 * grounded map away over one array. So an item the item schema would reject is
 * removed, and only the empty cases are filled in (`related: []`, a `missing`
 * given as one sentence rather than a list of one), neither of which asserts
 * anything the model did not write. Drop enough and the map falls under a
 * minimum and fails, which is the right outcome: reading the notes beats
 * shipping half a map.
 *
 * It lives here rather than in the shared provider because only this file
 * knows which parts are droppable. The provider sees `ZodType<T>` and nothing
 * else — it cannot know that a question with two keywords should be dropped
 * while a tutor reply with two citations is exactly right.
 */
export function repairPlan(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const concepts = asArray(value.concepts)
    .filter(isRecord)
    .filter((c) => typeof c.id === "string" && ID_RE.test(c.id))
    .slice(0, N.concepts.max);
  const ids = new Set(concepts.map((c) => String(c.id)));

  const repaired = concepts.map((c) => {
    const aliases = keepValid(strings(c.aliases), Alias);
    return {
      ...c,
      // A concept the model named but gave no alias for keeps its own name.
      // That is the model's word for it, not one invented here.
      aliases: aliases.length > 0 ? aliases : keepValid(strings([c.name]), Alias),
      related: strings(c.related).filter((r) => ids.has(r) && r !== c.id),
    };
  });

  const explainers: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(asRecord(value.explainers))) {
    if (!ids.has(id) || !isRecord(e)) continue;
    // `missing` comes back as one sentence about as often as it comes back as
    // a list of them. Same content, wrapped; nothing added.
    const fixed = { ...e, missing: typeof e.missing === "string" ? [e.missing] : strings(e.missing) };
    if (ExplainerShape.safeParse(fixed).success) explainers[id] = fixed;
  }

  const teachback = asRecord(value.teachback);
  const keywords: Record<string, unknown> = {};
  const hints: Record<string, unknown> = {};
  for (const [id, k] of Object.entries(asRecord(teachback.keywords))) {
    if (ids.has(id)) keywords[id] = keepValid(strings(k), Keyword);
  }
  for (const [id, h] of Object.entries(asRecord(teachback.hints))) {
    if (ids.has(id) && typeof h === "string") hints[id] = h;
  }

  // A key the model never wrote is left missing, so the schema refuses and the
  // reading path answers instead. Handing back an empty `explainers` or an
  // empty `teachback` would be repairing the parse and breaking the product:
  // a subject nobody can have explained to them, or be quizzed back on.
  const hasExplainers = isRecord(value.explainers);
  const hasTeachback = isRecord(value.teachback);
  return {
    ...value,
    concepts: keepValid(repaired, ConceptShape),
    examQuestions: keepValid(
      asArray(value.examQuestions)
        .filter(isRecord)
        .filter((q) => typeof q.conceptId === "string" && ids.has(q.conceptId))
        .map((q) => ({ ...q, requiredKeywords: keepValid(strings(q.requiredKeywords), Keyword) })),
      QuestionShape
    ),
    ...(hasExplainers ? { explainers } : {}),
    traps: keepValid(
      asArray(value.traps).filter(isRecord).filter((t) => typeof t.conceptId === "string" && ids.has(t.conceptId)),
      TrapShape
    ),
    ...(hasTeachback ? { teachback: { keywords, hints } } : {}),
    // Keyterms are the one list with no floor: they bias the dictation call and
    // `buildSubject` fills them from the concepts when they are empty, so an
    // absent list costs nothing and is not worth failing a whole map for.
    keyterms: keepValid(strings(value.keyterms), Keyterm),
  };
}

const PassageShape = z.object({
  heading: text(2, 70),
  text: text(N.passageChars.min, N.passageChars.max),
});
const WrittenShape = z.object({
  title: text(2, 90),
  subject: text(2, 60),
  passages: list(PassageShape, N.passages),
});
export type WrittenPassages = z.infer<typeof WrittenShape>;

/** Passages the model writes itself when the learner only gave a topic name. */
export const WrittenPassagesSchema = z.preprocess(
  // Same rule as the map: one passage that came back too thin to study from
  // costs that passage, not the other eleven.
  (value) => (isRecord(value) ? { ...value, passages: keepValid(asArray(value.passages), PassageShape) } : value),
  WrittenShape
) as unknown as z.ZodType<WrittenPassages>;

/**
 * The shape, spelled out.
 *
 * "Reply ONLY as JSON matching the schema you are given" does not tell a model
 * what the schema IS, and the model then answers in whatever shape the prose
 * implies. Every count below is read from `N`, which the validator reads too.
 */
const PLAN_SHAPE = [
  "Reply with ONE JSON object with EXACTLY these eight top-level keys, every one present every time:",
  '{"title": string, "subject": string,',
  ' "concepts": [{"id": "lower_snake_case", "name": string, "aliases": [string], "description": string, "related": [ids of other concepts]}],',
  ' "examQuestions": [{"conceptId": id, "question": string, "requiredKeywords": [string], "hint": string}],',
  ' "explainers": {"<concept id>": {"formal": string, "jargonFree": string, "missing": [string]}},',
  ' "traps": [{"conceptId": id, "statement": string, "whyWrong": string, "correct": string}],',
  ' "teachback": {"keywords": {"<concept id>": [string]}, "hints": {"<concept id>": string}},',
  ' "keyterms": [string]}',
  `Counts, all of them checked: ${N.concepts.min} to ${N.concepts.max} concepts, each with ${N.aliases.min} to ${N.aliases.max} aliases and up to ${N.related.max} related ids — write "related": [] when there are none rather than leaving the key out.`,
  `${N.examQuestions.min} to ${N.examQuestions.max} exam questions, every one of them with ${N.requiredKeywords.min} to ${N.requiredKeywords.max} requiredKeywords; a question with two is dropped.`,
  `One explainers entry per concept id, its "missing" always a list ([] when nothing is missing, never a bare sentence). ${N.traps.min} to ${N.traps.max} traps. Up to ${N.teachbackKeywords.max} teachback keywords per concept id, and one teachback hint per concept id. Up to ${N.keyterms.max} keyterms.`,
  "Nothing goes inside a concept: examQuestions, explainers, traps, teachback and keyterms are all top-level keys, and every id used in them must be one of the concept ids you wrote.",
  // Measured: the first fixed prompt got the keys and the nesting right and
  // then two of three replies simply stopped after examQuestions, as if the
  // object were finished. It is not finished until keyterms is written.
  "Write the keys in the order above and do not stop early: the object is not finished until keyterms is written, and one that stops before it is discarded whole.",
];

export const PLAN_SYSTEM = [
  "You turn a student's own study material into a map they can be quizzed on.",
  ...PLAN_SHAPE,
  'Rules: give every concept a short id in lower_snake_case, and a name in the words the material uses, written the way a heading would be — "Cell structure", not "cell"; name the idea, not one bare noun from it.',
  "Give every concept aliases a student might say out loud.",
  "Descriptions and explanations must come from the passages given — never add facts the material does not contain.",
  "Every exam question must be answerable from the passages, and its requiredKeywords are the words a correct spoken answer would contain.",
  "explainers: `formal` mirrors the material's own wording; `jargonFree` says the same thing in everyday language; `missing` lists what a learner still needs after hearing it.",
  "traps: the mistakes a student most plausibly makes on this material.",
  "keyterms: the words a speech recogniser should expect — concept names, aliases, technical terms.",
  "Plain English. No course codes, no praise, no meta commentary.",
].join("\n");

export const WRITE_SYSTEM = [
  "A student named a topic but gave you no notes. Write short study passages they can be quizzed against.",
  'Reply with ONE JSON object with EXACTLY these three keys: {"title": string, "subject": string, "passages": [{"heading": string, "text": string}]}.',
  `${N.passages.min} to ${N.passages.max} passages, each "text" between ${N.passageChars.min} and ${N.passageChars.max} characters, each with its own "heading".`,
  "Write what a careful textbook would say: accurate, specific, self-contained, no hedging and no filler.",
  "These passages will be shown to the student labelled as written for them, so they must be worth reading.",
].join("\n");

/** Read the learner's passages. null = no model, or output that failed twice. */
export async function planSubject(input: {
  title: string;
  passages: { id: string; text: string }[];
}): Promise<SubjectPlan | null> {
  const body = input.passages.map((p) => `[${p.id}] ${p.text}`).join("\n\n").slice(0, 24_000);
  const result = await reasonObject({
    system: PLAN_SYSTEM,
    user: [`What the student called it: ${input.title}`, `Their material:\n${body}`].join("\n\n"),
    schema: SubjectPlanSchema,
    timeoutMs: REASON_TIMEOUT_MS.intake,
  });
  return result?.value ?? null;
}

/** Write passages for a named topic. null = no model available. */
export async function writePassages(topic: string): Promise<WrittenPassages | null> {
  const result = await reasonObject({
    system: WRITE_SYSTEM,
    user: `Topic: ${topic}`,
    schema: WrittenPassagesSchema,
    timeoutMs: REASON_TIMEOUT_MS.intake,
  });
  return result?.value ?? null;
}

/**
 * A concept name a student reads as a heading, not as a bare noun.
 *
 * The map is written by a model, and a model reading a biology chapter
 * returns `"cell"` and `"resolution"` about as often as it returns
 * `"Cell structure"`. The app renders the name as the heading of a card, so
 * one shipped subject had headings in lower case while the next had them
 * capitalised. Upper-casing the first letter changes how it is presented and
 * nothing else — the word is still the material's own. A name that already
 * carries a capital anywhere ("pH scale", "mRNA", "Newton's first law") is
 * left exactly as the model wrote it, because raising its first letter would
 * make it a different word.
 *
 * The reading path (`intake/extract.ts`) already title-cases what it finds, so
 * this is the model path catching up rather than a second rule.
 */
export function conceptHeading(name: string): string {
  if (/\p{Lu}/u.test(name)) return name;
  return name.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Keep only what the plan grounds in real concepts, and give ids to questions. */
export function normalizePlan(plan: SubjectPlan): {
  concepts: ConceptDef[];
  examQuestions: ExamQuestion[];
  explainers: Record<string, Explainer>;
  traps: Trap[];
  teachback: { keywords: Record<string, string[]>; hints: Record<string, string> };
  keyterms: string[];
} {
  const ids = new Set(plan.concepts.map((c) => c.id));
  const concepts: ConceptDef[] = plan.concepts.map((c) => ({
    id: c.id,
    name: conceptHeading(c.name),
    aliases: c.aliases,
    description: c.description,
    related: c.related.filter((r) => ids.has(r) && r !== c.id),
  }));

  const examQuestions: ExamQuestion[] = plan.examQuestions
    .filter((q) => ids.has(q.conceptId))
    .map((q, i) => ({
      id: `q_${q.conceptId}_${i + 1}`,
      conceptId: q.conceptId,
      question: q.question,
      requiredKeywords: q.requiredKeywords,
      hint: q.hint,
    }));

  const explainers: Record<string, Explainer> = {};
  for (const [id, e] of Object.entries(plan.explainers)) {
    if (ids.has(id)) explainers[id] = e;
  }

  const traps: Trap[] = plan.traps
    .filter((t) => ids.has(t.conceptId))
    .map((t, i) => ({ id: `trap_${t.conceptId}_${i + 1}`, ...t }));

  const keywords: Record<string, string[]> = {};
  const hints: Record<string, string> = {};
  for (const [id, k] of Object.entries(plan.teachback.keywords)) if (ids.has(id)) keywords[id] = k;
  for (const [id, h] of Object.entries(plan.teachback.hints)) if (ids.has(id)) hints[id] = h;

  return { concepts, examQuestions, explainers, traps, teachback: { keywords, hints }, keyterms: plan.keyterms };
}
