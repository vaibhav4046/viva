import { keytermsFrom } from "@/lib/courses/subject";
import type { CourseSource, SourceLicence, Subject } from "@/lib/courses/types";
import { uid } from "@/lib/types";
import { chunkPages, MAX_CHUNKS, normalizeText, type IntakePage } from "./chunk";
import { extractSubjectBody, MIN_CONCEPTS } from "./extract";
import { normalizePlan, planSubject, writePassages } from "./model";

/**
 * One subject, built from whatever the learner gave us.
 *
 * Two paths, in order of preference:
 *  1. a language model reads their passages and writes the map;
 *  2. VIVA reads the passages itself (src/lib/intake/extract.ts).
 *
 * The second is weaker and the subject record says which one ran, so the
 * screen can tell the student the truth without them having to ask.
 *
 * The one thing neither path may do is invent the learner's material. A named
 * topic with no model available is therefore refused, not faked.
 */

/**
 * One document inside a subject.
 *
 * A subject can be several of these — a lecture PDF, a page from the module
 * website, the student's own notes — and each keeps its own title, its own
 * passages and its own licence, so a citation resolves to the document the
 * sentence is actually in rather than to "the subject".
 */
export type IntakeDoc = {
  title: string;
  /** How the source pane labels it: pdf, web, notes, written, text, doc. */
  type: string;
  pages: IntakePage[];
  /** What a citation says when a passage carried no heading of its own. */
  fallbackSection?: string;
  /** Where it was fetched from, when it came off the web. */
  url?: string;
  /** Set when somebody else wrote it and their terms travel with the words. */
  licence?: SourceLicence;
};

export type IntakeInput =
  | { kind: "paste"; title: string; text: string }
  | { kind: "pdf"; title: string; pages: IntakePage[] }
  | { kind: "named"; title: string }
  | { kind: "docs"; title: string; origin: Subject["origin"]; docs: IntakeDoc[] };

export type IntakeFailure = { code: "TOO_THIN" | "NEEDS_TEXT" | "NO_TEXT_IN_PDF"; message: string };

export type IntakeResult = { ok: true; subject: Subject } | { ok: false; error: IntakeFailure };

/** Every line here is read aloud to the student on /subjects. Keep them human. */
export type Progress = (line: string) => void;

const MIN_INPUT_CHARS = 400;

/**
 * A subject title, cleaned of things that cannot be rendered — and nothing else.
 *
 * Two copies of this lived in two routes with two different allowlists, and
 * neither allowed an em dash: "COMP319 Networks — TCP congestion control" was
 * stored as "COMP319 Networks TCP congestion control". The first thing a
 * student's own subject tells them about itself was already wrong, silently.
 * Strip control characters, keep typography.
 */
export function cleanTitle(raw: unknown, fallback: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/\.pdf$/i, "")
    // Control characters and the line breaks that would split a title.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    // Everything a course title reasonably carries stays: letters, digits,
    // marks (accents, Devanagari matras), dashes, quotes, brackets, & / + % #.
    .replace(/[^\p{L}\p{N}\p{M} ,.:;!?'’"“”()[\]{}&/+%#@°~^*=_|<>$€£¥\p{Pd}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, 120) || fallback;
}

function sourceTitleFor(input: IntakeInput): string {
  if (input.kind === "pdf") return input.title;
  if (input.kind === "paste") return `${input.title} — your notes`;
  if (input.kind === "docs") return input.title;
  return `${input.title} — written for you`;
}

/**
 * Every document becomes its own source, and the total is capped once.
 *
 * The per-document cap already lives in `chunkPages`; without a cap across
 * documents, five uploads would quietly become five times the ceiling.
 */
function sourcesFrom(docs: IntakeDoc[], baseId: string, single: boolean): CourseSource[] {
  const sources: CourseSource[] = [];
  let budget = MAX_CHUNKS;
  for (const [i, doc] of docs.entries()) {
    if (budget <= 0) break;
    const id = single ? baseId : `${baseId}_s${i + 1}`;
    const chunks = chunkPages(doc.pages, id, doc.fallbackSection ?? doc.title).slice(0, budget);
    if (!chunks.length) continue;
    budget -= chunks.length;
    sources.push({
      id,
      title: doc.title,
      type: doc.type,
      chunks,
      ...(doc.url ? { url: doc.url } : {}),
      ...(doc.licence ? { licence: doc.licence } : {}),
    });
  }
  return sources;
}

export async function buildSubject(
  input: IntakeInput,
  ownerId: string,
  onProgress: Progress = () => {}
): Promise<IntakeResult> {
  const subjectId = uid("subject");
  const sourceId = `src_${subjectId.slice(8)}`;
  const title = input.title.trim().slice(0, 90) || "Your subject";

  // --- 1. Get the passages -------------------------------------------------
  let pages: IntakePage[];
  let origin: Subject["origin"];
  let written = false;
  let docs: IntakeDoc[] | null = null;

  if (input.kind === "docs") {
    docs = input.docs.filter((d) => d.pages.some((p) => p.text.trim().length > 0));
    if (!docs.length) {
      return { ok: false, error: { code: "TOO_THIN", message: "VIVA could not find any readable text in that." } };
    }
    pages = docs.flatMap((d) => d.pages);
    origin = input.origin;
  } else if (input.kind === "named") {
    onProgress("Writing a starting set of notes…");
    const drafted = await writePassages(title);
    if (!drafted) {
      return {
        ok: false,
        error: {
          code: "NEEDS_TEXT",
          message:
            "VIVA can build a subject from your material, but it cannot write the material for you right now. Paste some notes or upload a PDF and it will read those instead.",
        },
      };
    }
    pages = drafted.passages.map((p) => ({ text: `${p.heading}. ${p.text}` }));
    origin = "named";
    written = true;
  } else if (input.kind === "pdf") {
    pages = input.pages;
    origin = "pdf";
  } else {
    pages = [{ text: normalizeText(input.text) }];
    origin = "paste";
  }

  const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
  if (totalChars < MIN_INPUT_CHARS) {
    return {
      ok: false,
      error: {
        code: "TOO_THIN",
        message: "That is not quite enough to study from. A few paragraphs — around 100 words or more — gives VIVA something to work with.",
      },
    };
  }

  onProgress(docs && docs.length > 1 ? "Reading your sources…" : "Reading your notes…");
  const sources = sourcesFrom(
    docs ?? [{
      title: sourceTitleFor(input),
      type: input.kind === "pdf" ? "pdf" : input.kind === "named" ? "written" : "notes",
      pages,
      fallbackSection: written ? "Written for you" : "Your notes",
    }],
    sourceId,
    !docs || docs.length === 1
  );
  const chunks = sources.flatMap((s) => s.chunks);
  if (chunks.length === 0) {
    return { ok: false, error: { code: "TOO_THIN", message: "VIVA could not find any readable text in that." } };
  }

  // --- 2. Make the map -----------------------------------------------------
  onProgress("Finding the ideas in it…");
  const plan = await planSubject({ title, passages: chunks.map((c) => ({ id: c.id, text: c.text })) });

  const base = {
    id: subjectId,
    code: codeFor(title),
    sources,
    ownerId,
    createdAt: new Date().toISOString(),
    demo: false,
    origin,
    languageCodes: ["en"],
  };

  if (plan) {
    onProgress("Writing your questions…");
    const body = normalizePlan(plan);
    if (body.concepts.length >= MIN_CONCEPTS && body.examQuestions.length >= 4) {
      return {
        ok: true,
        subject: {
          ...base,
          title: plan.title.trim() || title,
          subject: plan.subject.trim() || title,
          builtBy: "model",
          ...body,
          keyterms: body.keyterms.length ? body.keyterms.slice(0, 60) : keytermsFrom(body.concepts, 60),
        },
      };
    }
  }

  // --- 3. No model, or the model came back unusable: read it ourselves ------
  onProgress("Working through it line by line…");
  const rawText = pages.map((p) => p.text).join("\n");
  const extracted = extractSubjectBody(chunks, rawText);
  if (!extracted) {
    return {
      ok: false,
      error: {
        code: "TOO_THIN",
        message: "VIVA read that but could not find enough distinct ideas to quiz you on. Longer notes, or notes with headings, work best.",
      },
    };
  }

  onProgress("Writing your questions…");
  return {
    ok: true,
    subject: {
      ...base,
      title,
      subject: title,
      builtBy: "reading",
      concepts: extracted.concepts,
      examQuestions: extracted.examQuestions,
      explainers: extracted.explainers,
      teachback: extracted.teachback,
      // Naming a plausible mistake means knowing the material; reading the
      // words on the page does not. So this path ships none rather than guess.
      traps: [],
      keyterms: extracted.keyterms,
    },
  };
}

/** A short label for the picker: initials of the title, plus the year. */
function codeFor(title: string): string {
  const initials = title
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
  return `${initials || "SUB"}${new Date().getFullYear() % 100}`;
}
