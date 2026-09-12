import { keytermsFrom } from "@/lib/courses/subject";
import type { CourseSource, Subject } from "@/lib/courses/types";
import { uid } from "@/lib/types";
import { chunkPages, normalizeText, type IntakePage } from "./chunk";
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

export type IntakeInput =
  | { kind: "paste"; title: string; text: string }
  | { kind: "pdf"; title: string; pages: IntakePage[] }
  | { kind: "named"; title: string };

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
  return `${input.title} — written for you`;
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

  if (input.kind === "named") {
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

  onProgress("Reading your notes…");
  const chunks = chunkPages(pages, sourceId, written ? "Written for you" : "Your notes");
  if (chunks.length === 0) {
    return { ok: false, error: { code: "TOO_THIN", message: "VIVA could not find any readable text in that." } };
  }

  const source: CourseSource = {
    id: sourceId,
    title: sourceTitleFor(input),
    type: input.kind === "pdf" ? "pdf" : input.kind === "named" ? "written" : "notes",
    chunks,
  };

  // --- 2. Make the map -----------------------------------------------------
  onProgress("Finding the ideas in it…");
  const plan = await planSubject({ title, passages: chunks.map((c) => ({ id: c.id, text: c.text })) });

  const base = {
    id: subjectId,
    code: codeFor(title),
    sources: [source],
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
