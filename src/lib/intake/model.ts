import { z } from "zod";
import { REASON_TIMEOUT_MS, reasonObject } from "@/lib/ai/reason";
import type { ConceptDef, ExamQuestion, Explainer, Trap } from "@/lib/courses/types";

/**
 * The model path (Master prompt §6 step 2).
 *
 * The model reads the learner's passages and writes the map: concepts, exam
 * questions, two explanations per concept, the traps worth warning about, and
 * the recognition terms the dictation call biases towards. Everything is
 * schema-validated; the provider itself makes one repair attempt, and a second
 * failure returns null so the caller can read the notes itself instead.
 */

const Id = z.string().min(2).max(60).regex(/^[a-z0-9_]+$/);

export const SubjectPlanSchema = z.object({
  title: z.string().min(2).max(90),
  subject: z.string().min(2).max(60),
  concepts: z.array(z.object({
    id: Id,
    name: z.string().min(2).max(70),
    aliases: z.array(z.string().min(2).max(50)).min(1).max(8),
    description: z.string().min(10).max(400),
    related: z.array(Id).max(4),
  })).min(6).max(10),
  examQuestions: z.array(z.object({
    conceptId: Id,
    question: z.string().min(10).max(220),
    requiredKeywords: z.array(z.string().min(2).max(40)).min(3).max(6),
    hint: z.string().min(5).max(240),
  })).min(5).max(8),
  explainers: z.record(Id, z.object({
    formal: z.string().min(20).max(700),
    jargonFree: z.string().min(20).max(700),
    missing: z.array(z.string().max(160)).max(4),
  })),
  traps: z.array(z.object({
    conceptId: Id,
    statement: z.string().min(10).max(300),
    whyWrong: z.string().min(10).max(500),
    correct: z.string().min(5).max(300),
  })).min(2).max(4),
  teachback: z.object({
    keywords: z.record(Id, z.array(z.string().min(2).max(40)).max(8)),
    hints: z.record(Id, z.string().max(240)),
  }),
  keyterms: z.array(z.string().min(2).max(50)).max(60),
});
export type SubjectPlan = z.infer<typeof SubjectPlanSchema>;

/** Passages the model writes itself when the learner only gave a topic name. */
export const WrittenPassagesSchema = z.object({
  title: z.string().min(2).max(90),
  subject: z.string().min(2).max(60),
  passages: z.array(z.object({
    heading: z.string().min(2).max(70),
    text: z.string().min(120).max(1200),
  })).min(8).max(12),
});
export type WrittenPassages = z.infer<typeof WrittenPassagesSchema>;

const PLAN_SYSTEM = [
  "You turn a student's own study material into a map they can be quizzed on.",
  "Reply ONLY as JSON matching the schema you are given.",
  "Rules: 6 to 10 concepts, each with a short id in lower_snake_case, a name in the words the material uses, and aliases a student might say out loud.",
  "Descriptions and explanations must come from the passages given — never add facts the material does not contain.",
  "Every exam question must be answerable from the passages, with 3 to 6 required keywords a correct spoken answer would contain.",
  "explainers: `formal` mirrors the material's own wording; `jargonFree` says the same thing in everyday language; `missing` lists what a learner still needs after hearing it.",
  "traps: the two to four mistakes a student most plausibly makes on this material.",
  "keyterms: the words a speech recogniser should expect — concept names, aliases, technical terms.",
  "Plain English. No course codes, no praise, no meta commentary.",
].join(" ");

const WRITE_SYSTEM = [
  "A student named a topic but gave you no notes. Write short study passages they can be quizzed against.",
  "Reply ONLY as JSON matching the schema. 8 to 12 passages, each 120 to 1200 characters, each with a heading.",
  "Write what a careful textbook would say: accurate, specific, self-contained, no hedging and no filler.",
  "These passages will be shown to the student labelled as written for them, so they must be worth reading.",
].join(" ");

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
    name: c.name,
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
