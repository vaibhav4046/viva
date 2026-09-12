import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { setReasoningProvider, type ReasoningProvider } from "@/lib/ai/provider";
import { cleanTitle } from "@/lib/intake/build";
import { resolveSubject } from "@/lib/courses/subject";
import { chunkPages, CHUNK_CHARS } from "@/lib/intake/chunk";
import { extractSubjectBody } from "@/lib/intake/extract";
import { buildSubject } from "@/lib/intake/build";
import { SubjectPlanSchema, WrittenPassagesSchema } from "@/lib/intake/model";
import { FileEventStore } from "@/lib/store/file";
import { bandKeyFor } from "@/lib/mastery";

/**
 * Subject intake, both paths.
 *
 * There are no LLM credentials here (or in production right now), so the model
 * path runs against a stub injected through the same seam the real provider
 * uses, and the reading path runs with no provider at all. Both have to produce
 * a subject a student could actually sit down with.
 */

const LECTURE = `
SN1 versus SN2 mechanisms

Nucleophilic substitution is a reaction in which a nucleophile replaces a leaving group on a carbon atom. Two limiting mechanisms describe almost every case you will meet this term, and the exam question is nearly always which one dominates.

The SN1 mechanism is a two-step process that begins with the departure of the leaving group to form a carbocation intermediate. Because that first step is slow and does not involve the nucleophile, the rate depends only on the concentration of the substrate. The carbocation is planar, so the nucleophile can attack from either face and the product is a racemic mixture.

Carbocation stability decides whether SN1 is available at all. A tertiary carbocation is stabilised by hyperconjugation from three alkyl groups, a secondary carbocation is less stable, and a primary carbocation is so unstable that SN1 essentially never happens on a primary carbon. This is why tertiary halides favour SN1 and primary halides do not.

The SN2 mechanism is a single concerted step in which the nucleophile attacks the carbon at the same time as the leaving group departs. The rate depends on the concentration of both the substrate and the nucleophile, which is why it is called second order. Because the nucleophile must approach from the side opposite the leaving group, the stereochemistry at the carbon inverts. This inversion of configuration is called Walden inversion and it is the single most reliable fingerprint of an SN2 reaction.

Steric hindrance is what kills SN2. A tertiary carbon is surrounded by three alkyl groups and the backside approach is blocked, so SN2 is effectively impossible there. A methyl or primary carbon has an open backside and reacts readily. Secondary carbons sit in the middle and the mechanism that wins depends on the solvent and the nucleophile.

Solvent choice pushes the balance either way. A polar protic solvent such as water or ethanol hydrogen bonds to the nucleophile and stabilises the carbocation intermediate, which favours SN1. A polar aprotic solvent such as acetone or dimethyl sulfoxide leaves the nucleophile bare and reactive, which favours SN2.

Nucleophile strength matters only for SN2. A strong nucleophile such as hydroxide or cyanide drives the concerted attack. In SN1 the nucleophile arrives after the rate determining step, so a weak nucleophile such as water works perfectly well and the reaction is often called solvolysis.

The leaving group must be stable once it has left. Iodide is an excellent leaving group because the resulting anion is large and the charge is spread out; fluoride is a poor leaving group for the opposite reason. A good leaving group speeds up both mechanisms, so it does not help you tell them apart.

Putting it together: identify the carbon, look at the nucleophile, then look at the solvent. Tertiary carbon with a weak nucleophile in a protic solvent is SN1 with racemisation. Primary carbon with a strong nucleophile in an aprotic solvent is SN2 with inversion.
`.trim();

class StubProvider implements ReasoningProvider {
  readonly name = "stub-model";
  constructor(private readonly reply: (system: string) => unknown) {}
  async generateText(): Promise<string> { return ""; }
  async generateObject<T>(input: { system: string; schema: ZodType<T> }): Promise<T> {
    return input.schema.parse(this.reply(input.system));
  }
}

/** A plausible model reply for the lecture above. */
function plannedSubject() {
  const ids = ["sn1", "sn2", "carbocation", "steric_hindrance", "solvent_effects", "leaving_group"];
  return SubjectPlanSchema.parse({
    title: "SN1 vs SN2",
    subject: "Organic chemistry",
    concepts: ids.map((id) => ({
      id,
      name: id.replace(/_/g, " "),
      aliases: [id.replace(/_/g, " "), `${id} mechanism`],
      description: `What the notes say about ${id.replace(/_/g, " ")}.`,
      related: [],
    })),
    examQuestions: ids.slice(0, 5).map((id) => ({
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
      { conceptId: "sn1", statement: "SN1 inverts the stereochemistry.", whyWrong: "The carbocation is planar, so attack happens from both faces.", correct: "SN1 racemises; SN2 inverts." },
      { conceptId: "sn2", statement: "A tertiary carbon reacts fastest by SN2.", whyWrong: "Three alkyl groups block the backside approach.", correct: "SN2 is fastest on methyl and primary carbons." },
    ],
    teachback: {
      keywords: Object.fromEntries(ids.map((id) => [id, ["rate", "carbon", "nucleophile"]])),
      hints: Object.fromEntries(ids.map((id) => [id, "Start with the rate law."])),
    },
    keyterms: ["SN1", "SN2", "carbocation", "Walden inversion"],
  });
}

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-intake-"));
  process.env.DATA_DIR = tmp;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});
afterEach(() => setReasoningProvider(null));

describe("chunking", () => {
  it("cuts at 800 characters with overlap and keeps the page number", () => {
    const long = "alpha beta gamma delta epsilon ".repeat(120); // ~3600 chars
    const chunks = chunkPages([{ text: long, page: 7 }], "src_x", "Your notes");
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.locator.page).toBe(7);
      expect(c.locator.section).toBe("Page 7");
    }
    // Consecutive passages share their seam, so a sentence split across the
    // boundary is still retrievable whole from one of them.
    const tail = chunks[0].text.slice(-40);
    expect(chunks[1].text.startsWith(tail.slice(-10)) || chunks[1].text.includes(tail.slice(0, 10))).toBe(true);
  });

  it("never merges two pages into one passage", () => {
    const chunks = chunkPages([{ text: "Page one text.", page: 1 }, { text: "Page two text.", page: 2 }], "src_y", "Notes");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].locator.page).toBe(1);
    expect(chunks[1].locator.page).toBe(2);
  });
});

describe("reading the notes with no model", () => {
  it("pulls real concepts and answerable questions out of a lecture", () => {
    const chunks = chunkPages([{ text: LECTURE }], "src_sn", "Your notes");
    const body = extractSubjectBody(chunks, LECTURE);
    expect(body).not.toBeNull();
    if (!body) return;

    expect(body.concepts.length).toBeGreaterThanOrEqual(6);
    expect(body.examQuestions.length).toBeGreaterThanOrEqual(5);

    const names = body.concepts.map((c) => c.name.toLowerCase()).join(" | ");
    // The material is about substitution, so the map has to be about that too.
    expect(names).toMatch(/sn1|sn2|carbocation|nucleophil|leaving group|solvent|steric/);
    // and must not be about the starter subject.
    expect(names).not.toMatch(/attention|transformer/);

    // Every description is a sentence that actually appears in their notes.
    const source = LECTURE.replace(/\s+/g, " ");
    for (const c of body.concepts) expect(source).toContain(c.description.slice(0, 60));

    for (const q of body.examQuestions) {
      expect(q.requiredKeywords.length).toBeGreaterThanOrEqual(3);
      expect(q.requiredKeywords.length).toBeLessThanOrEqual(6);
      expect(body.concepts.some((c) => c.id === q.conceptId)).toBe(true);
      expect(q.hint.length).toBeGreaterThan(10);
    }
  });

  it("refuses rather than half-building when there is nothing to read", () => {
    const chunks = chunkPages([{ text: "Hello. This is short. Nothing here." }], "src_thin", "Notes");
    expect(extractSubjectBody(chunks, "Hello. This is short. Nothing here.")).toBeNull();
  });
});

describe("buildSubject", () => {
  it("uses the model when one answers, and says so", async () => {
    setReasoningProvider(new StubProvider(() => plannedSubject()));
    const lines: string[] = [];
    const out = await buildSubject({ kind: "paste", title: "SN1 vs SN2", text: LECTURE }, "u_intake_model", (l) => lines.push(l));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.builtBy).toBe("model");
    expect(out.subject.origin).toBe("paste");
    expect(out.subject.concepts.length).toBeGreaterThanOrEqual(6);
    expect(out.subject.traps.length).toBeGreaterThanOrEqual(2);
    // Every explainer has a plain-language version when a model wrote it.
    for (const e of Object.values(out.subject.explainers)) expect(e.jargonFree.length).toBeGreaterThan(10);
    expect(lines.join(" ")).toMatch(/Reading your notes/);
  });

  it("reads the notes itself when no model is configured", async () => {
    const out = await buildSubject({ kind: "paste", title: "SN1 vs SN2", text: LECTURE }, "u_intake_read");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.builtBy).toBe("reading");
    expect(out.subject.concepts.length).toBeGreaterThanOrEqual(6);
    expect(out.subject.examQuestions.length).toBeGreaterThanOrEqual(5);
    // No model means no invented traps and no invented analogies.
    expect(out.subject.traps).toEqual([]);
    expect(out.subject.sources[0].chunks.length).toBeGreaterThan(0);
    expect(out.subject.keyterms.length).toBeGreaterThan(0);
  });

  it("falls back to reading when the model answers with something unusable", async () => {
    // Two concepts is a half-built subject; the reading path is better than that.
    setReasoningProvider(new StubProvider(() => { throw new Error("schema refused"); }));
    const out = await buildSubject({ kind: "paste", title: "SN1 vs SN2", text: LECTURE }, "u_intake_repair");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.builtBy).toBe("reading");
  });

  it("refuses to invent material for a named topic with no model", async () => {
    const out = await buildSubject({ kind: "named", title: "The Krebs cycle" }, "u_intake_named");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("NEEDS_TEXT");
    expect(out.error.message).toMatch(/paste|upload/i);
  });

  it("writes labelled passages for a named topic when a model can", async () => {
    setReasoningProvider(new StubProvider((system) =>
      system.includes("no notes")
        ? WrittenPassagesSchema.parse({
            title: "The Krebs cycle",
            subject: "Biochemistry",
            passages: Array.from({ length: 9 }, (_, i) => ({
              heading: `Step ${i + 1}`,
              text: `Step ${i + 1} of the citric acid cycle, described in enough detail to be quizzed on. `.repeat(3),
            })),
          })
        : plannedSubject()
    ));
    const out = await buildSubject({ kind: "named", title: "The Krebs cycle" }, "u_intake_written");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.origin).toBe("named");
    // The learner must be able to see these were not their own notes.
    expect(out.subject.sources[0].title).toMatch(/written for you/i);
    expect(out.subject.sources[0].chunks[0].locator.section).toBe("Written for you");
  });

  it("turns away material too thin to study from", async () => {
    const out = await buildSubject({ kind: "paste", title: "Nothing", text: "Two words." }, "u_intake_thin");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("TOO_THIN");
  });
});

describe("a saved subject behaves like any other", () => {
  it("resolves, retrieves from its own passages, and starts every concept at Not yet", async () => {
    const store = new FileEventStore();
    const user = `u_saved_${Date.now().toString(36)}`;
    try {
      const out = await buildSubject({ kind: "paste", title: "SN1 vs SN2", text: LECTURE }, user);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      await store.saveSubject(user, out.subject);

      const resolved = await resolveSubject(store, user, out.subject.id);
      expect(resolved.id).toBe(out.subject.id);
      expect(resolved.demo).toBe(false);

      const chunks = await store.getCourseChunks(user, out.subject.id);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.text.length > 0)).toBe(true);

      const hits = await store.retrieveEvidence(user, "why does a tertiary carbon block backside attack", {
        courseId: out.subject.id, limit: 3,
      });
      expect(hits.length).toBeGreaterThan(0);
      // The passages cited belong to this subject, not to a starter.
      expect(hits.every((h) => chunks.some((c) => c.id === h.chunk.id))).toBe(true);
      expect(hits[0].chunk.text.toLowerCase()).toMatch(/steric|tertiary|backside|carbon/);

      // A subject the learner just built carries no record of them using it:
      // every concept reads "Not yet" until they say something about it.
      const mastery = await store.getMastery(user);
      expect(mastery).toEqual({});
      for (const c of out.subject.concepts) {
        expect(bandKeyFor(mastery[c.id])).toBe("notyet");
      }
    } finally {
      await store.deleteUserData(user).catch(() => {});
    }
  });
});

describe("a subject keeps the name the student gave it", () => {
  it("keeps an em dash, an en dash and a colon", () => {
    // Reproduced live: the allowlist had no dash, so a student's own subject
    // renamed itself the moment they created it.
    expect(cleanTitle("COMP319 Networks \u2014 TCP congestion control", "x"))
      .toBe("COMP319 Networks \u2014 TCP congestion control");
    expect(cleanTitle("Stats 2: Bayes \u2013 priors & posteriors", "x"))
      .toBe("Stats 2: Bayes \u2013 priors & posteriors");
  });
  it("keeps accents and non-Latin scripts", () => {
    expect(cleanTitle("Th\u00e9orie des probabilit\u00e9s", "x")).toBe("Th\u00e9orie des probabilit\u00e9s");
    expect(cleanTitle("\u0938\u0902\u0917\u0923\u0915 \u0935\u093f\u091c\u094d\u091e\u093e\u0928", "x"))
      .toBe("\u0938\u0902\u0917\u0923\u0915 \u0935\u093f\u091c\u094d\u091e\u093e\u0928");
  });
  it("still strips control characters, paths and the .pdf tail", () => {
    expect(cleanTitle("../../etc/passwd.pdf", "x")).toBe("passwd");
    expect(cleanTitle("Week 4\tnotes\nline two", "x")).toBe("Week 4 notes line two");
    expect(cleanTitle("   ", "Your notes")).toBe("Your notes");
  });
});
