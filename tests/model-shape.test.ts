import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PLAN_SYSTEM,
  SubjectPlanSchema,
  WRITE_SYSTEM,
  WrittenPassagesSchema,
} from "@/lib/intake/model";
import { ASSESS_SYSTEM } from "@/lib/tutor/assess";
import { INTENT_SYSTEM, TUTOR_SYSTEM } from "@/lib/tutor/respond";
import { AssessmentReplySchema, IntentConfirmSchema, TutorReplySchema } from "@/lib/tutor/schema";

/**
 * A prompt that validates against a schema has to describe that schema.
 *
 * This is the bug that had 100% of tutor turns silently answering from the
 * heuristic path for hours, and then had `planSubject` throwing away whole
 * grounded subject maps: the prompt said "reply as the JSON schema" and never
 * said what the schema was, so the model answered in a shape of its own
 * invention. The guard below is derived from the schemas rather than written
 * out, so a key added to a schema tomorrow fails here until the prompt names
 * it too.
 */
function keysOf(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).flatMap(([key, value]) => [key, ...keysOf(value)]);
  }
  if (schema instanceof z.ZodArray) return keysOf(schema.element as z.ZodTypeAny);
  if (schema instanceof z.ZodEffects) return keysOf(schema._def.schema as z.ZodTypeAny);
  if (schema instanceof z.ZodRecord) return keysOf(schema._def.valueType as z.ZodTypeAny);
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return keysOf(schema.unwrap() as z.ZodTypeAny);
  return [];
}

const PROMPTS: [string, string, z.ZodTypeAny][] = [
  ["the subject map", PLAN_SYSTEM, SubjectPlanSchema as unknown as z.ZodTypeAny],
  ["written passages", WRITE_SYSTEM, WrittenPassagesSchema as unknown as z.ZodTypeAny],
  ["the tutor reply", TUTOR_SYSTEM, TutorReplySchema],
  ["the intent check", INTENT_SYSTEM, IntentConfirmSchema],
  ["the grade", ASSESS_SYSTEM, AssessmentReplySchema],
];

describe("every model prompt names the keys it will be validated against", () => {
  for (const [name, prompt, schema] of PROMPTS) {
    it(`${name} prompt names every key of its schema`, () => {
      const missing = [...new Set(keysOf(schema))].filter((key) => !prompt.includes(key));
      expect(missing, `${name}: prompt never mentions ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("names every intent the schema accepts, so none is unreachable", () => {
    for (const intent of ["confused", "claim", "explain", "quiz", "teach", "answer", "hint", "note"]) {
      expect(INTENT_SYSTEM).toContain(intent);
    }
  });

  it("quotes the counts it actually enforces", () => {
    expect(PLAN_SYSTEM).toContain("6 to 10 concepts");
    expect(PLAN_SYSTEM).toContain("3 to 6 requiredKeywords");
    expect(SubjectPlanSchema.safeParse(rawPlan({ concepts: 5 })).success).toBe(false);
    expect(SubjectPlanSchema.safeParse(rawPlan({ concepts: 6 })).success).toBe(true);
  });
});

/** A model reply in the shape the prompt asks for, with the requested damage. */
function rawPlan(opts: { concepts?: number; questions?: number } = {}) {
  const ids = ["sn1", "sn2", "carbocation", "steric", "solvent", "leaving_group", "stereochem"].slice(0, opts.concepts ?? 6);
  return {
    title: "SN1 vs SN2",
    subject: "Organic chemistry",
    concepts: ids.map((id) => ({
      id,
      name: id.replace(/_/g, " "),
      aliases: [id.replace(/_/g, " ")],
      description: `What the notes say about ${id.replace(/_/g, " ")}.`,
      related: [],
    })),
    examQuestions: ids.slice(0, opts.questions ?? 6).map((id) => ({
      conceptId: id,
      question: `What decides ${id.replace(/_/g, " ")}?`,
      requiredKeywords: ["rate", "carbon", "nucleophile"],
      hint: "Think about the rate determining step.",
    })),
    explainers: Object.fromEntries(ids.map((id) => [id, {
      formal: `The formal account of ${id.replace(/_/g, " ")} as the notes give it.`,
      jargonFree: `The everyday version of ${id.replace(/_/g, " ")}, with no technical words.`,
      missing: ["why the rate law differs"],
    }])),
    traps: [
      { conceptId: ids[0], statement: "SN1 inverts the stereochemistry.", whyWrong: "The carbocation is planar, so attack happens from both faces.", correct: "SN1 racemises; SN2 inverts." },
      { conceptId: ids[1], statement: "A tertiary carbon reacts fastest by SN2.", whyWrong: "Three alkyl groups block the backside approach.", correct: "SN2 is fastest on methyl and primary carbons." },
    ],
    teachback: {
      keywords: Object.fromEntries(ids.map((id) => [id, ["rate", "carbon", "nucleophile"]])),
      hints: Object.fromEntries(ids.map((id) => [id, "Start with the rate law."])),
    },
    keyterms: ["SN1", "SN2", "carbocation"],
  };
}

describe("the subject map repairs by dropping, never by inventing", () => {
  it("accepts a map that left `related` off every concept", () => {
    const raw = rawPlan();
    for (const c of raw.concepts) delete (c as { related?: string[] }).related;
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concepts.every((c) => Array.isArray(c.related) && c.related.length === 0)).toBe(true);
  });

  it("drops the one question short of three keywords and keeps the others as written", () => {
    const raw = rawPlan({ questions: 6 });
    raw.examQuestions[2].requiredKeywords = ["rate", "carbon"];
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.examQuestions).toHaveLength(5);
    // Dropped, not topped up with a third keyword nobody wrote.
    expect(parsed.data.examQuestions.some((q) => q.question === raw.examQuestions[2].question)).toBe(false);
    for (const q of parsed.data.examQuestions) expect(q.requiredKeywords).toEqual(["rate", "carbon", "nucleophile"]);
  });

  it("fails the whole map when dropping leaves too little to study", () => {
    const raw = rawPlan({ questions: 6 });
    for (const q of raw.examQuestions) q.requiredKeywords = ["rate", "carbon"];
    expect(SubjectPlanSchema.safeParse(raw).success).toBe(false);
  });

  it("clips prose that ran over its display budget instead of refusing the map", () => {
    const raw = rawPlan();
    raw.concepts[0].description = "x".repeat(406);
    raw.title = "y".repeat(96);
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concepts[0].description).toHaveLength(400);
    expect(parsed.data.concepts[0].description.endsWith("…")).toBe(true);
    expect(parsed.data.title).toHaveLength(90);
  });

  it("still refuses prose that is missing rather than long", () => {
    const raw = rawPlan();
    raw.concepts[0].description = "short";
    expect(SubjectPlanSchema.safeParse(raw).success).toBe(false);
  });

  it("drops a concept whose id could never resolve, and everything that referenced it", () => {
    const raw = rawPlan({ concepts: 7, questions: 7 });
    raw.concepts[3].id = "Steric Hindrance";
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concepts).toHaveLength(6);
    expect(parsed.data.concepts.some((c) => c.id === "Steric Hindrance")).toBe(false);
    expect(parsed.data.examQuestions.some((q) => q.conceptId === "Steric Hindrance")).toBe(false);
    expect(Object.keys(parsed.data.explainers)).not.toContain("Steric Hindrance");
  });

  it("keeps a `missing` that came back as one sentence rather than a list of one", () => {
    const raw = rawPlan();
    (raw.explainers.sn1 as { missing: unknown }).missing = "why the rate law differs";
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.explainers.sn1.missing).toEqual(["why the rate law differs"]);
  });

  it("trims a list that ran over its ceiling", () => {
    const raw = rawPlan({ concepts: 7, questions: 6 });
    const extra = Array.from({ length: 5 }, (_, i) => ({
      ...raw.concepts[0],
      id: `extra_${i}`,
      name: `extra ${i}`,
    }));
    const parsed = SubjectPlanSchema.safeParse({ ...raw, concepts: [...raw.concepts, ...extra] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concepts).toHaveLength(10);
  });

  it("gives a concept with no aliases its own name, and nothing else", () => {
    const raw = rawPlan();
    raw.concepts[0].aliases = [];
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concepts[0].aliases).toEqual([raw.concepts[0].name]);
  });

  it("refuses a map with no explanations or no teach-back, rather than shipping half a subject", () => {
    for (const key of ["explainers", "teachback"] as const) {
      const raw: Record<string, unknown> = { ...rawPlan() };
      delete raw[key];
      expect(SubjectPlanSchema.safeParse(raw).success, `a map with no ${key} must not pass`).toBe(false);
    }
  });

  it("lets a map through with no keyterms, which the build fills from the concepts", () => {
    const raw: Record<string, unknown> = { ...rawPlan() };
    delete raw.keyterms;
    const parsed = SubjectPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.keyterms).toEqual([]);
  });

  it("drops the thin passage rather than the whole set of written notes", () => {
    const passage = (i: number) => ({
      heading: `Step ${i}`,
      text: `Step ${i} of the citric acid cycle, described in enough detail to be quizzed on. `.repeat(3),
    });
    const raw = {
      title: "The Krebs cycle",
      subject: "Biochemistry",
      passages: [...Array.from({ length: 9 }, (_, i) => passage(i + 1)), { heading: "Too thin", text: "Not enough." }],
    };
    const parsed = WrittenPassagesSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.passages).toHaveLength(9);
  });
});
