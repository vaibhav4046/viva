import { createHash } from "node:crypto";
import { MAX_DOC_CHARS, MAX_TITLE_CHARS, type Passage, type Section, type SourceDocument } from "./types";
import { sentences } from "./text";

/**
 * Text in, citable passages out.
 *
 * A passage is one sentence, or one list item. Small on purpose: a verdict has
 * to point at the exact words that decided it, and a 800-character chunk that
 * "contains" the answer is not a citation, it is a place to start reading.
 *
 * Passage ids are `<doc>.<n>` where `<doc>` is a hash of the owner and the text.
 * Two documents therefore cannot produce the same id, so a passage id that
 * arrives from the agent can be checked against the session's own document and
 * is either that document's or nothing at all. It cannot be invented into
 * existence and it cannot name another user's material.
 */

export class DocumentError extends Error {
  constructor(readonly code: "EMPTY" | "TOO_LONG" | "TOO_SHORT", message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

const HEADING = /^(#{1,4})\s+(.+?)\s*#*$/;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
const MAX_PASSAGE_CHARS = 420;

/** Collapse to one line, no control characters, capped. Titles reach a prompt. */
export function cleanTitle(raw: string): string {
  const t = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (t || "Untitled document").slice(0, MAX_TITLE_CHARS);
}

function wordWindows(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_PASSAGE_CHARS) {
    let cut = rest.lastIndexOf(" ", MAX_PASSAGE_CHARS);
    if (cut < MAX_PASSAGE_CHARS / 2) cut = MAX_PASSAGE_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function buildDocument(input: { ownerId: string; title: string; text: string; sample?: boolean }): SourceDocument {
  const raw = input.text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  if (!raw.trim()) throw new DocumentError("EMPTY", "There is no text in that document to review.");
  if (raw.length > MAX_DOC_CHARS) {
    throw new DocumentError("TOO_LONG", `That document is longer than ${MAX_DOC_CHARS.toLocaleString("en-US")} characters. Paste the part you need to defend.`);
  }

  const id = "d" + createHash("sha256").update(`${input.ownerId}\n${input.title}\n${raw}`).digest("hex").slice(0, 8);
  const sections: Section[] = [];
  const passages: Passage[] = [];

  const startSection = (heading: string): Section => {
    const s: Section = { id: `${id}.s${sections.length}`, heading, ordinal: sections.length, passageIds: [] };
    sections.push(s);
    return s;
  };
  let current = startSection("Document");
  let sawHeading = false;

  const push = (text: string) => {
    for (const piece of wordWindows(text)) {
      if (piece.length < 3) continue;
      const ordinal = passages.length;
      const p: Passage = { id: `${id}.${ordinal}`, sectionId: current.id, section: current.heading, ordinal, text: piece };
      passages.push(p);
      current.passageIds.push(p.id);
    }
  };

  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    for (const s of sentences(para.join(" "))) push(s);
    para = [];
  };

  for (const line of raw.split("\n")) {
    const h = HEADING.exec(line.trim());
    if (h) {
      flush();
      // A heading before any passage renames the opening section instead of
      // leaving an empty one behind it.
      if (!sawHeading && current.passageIds.length === 0) current.heading = h[2].trim();
      else current = startSection(h[2].trim());
      sawHeading = true;
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      flush();
      push(li[1].trim());
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();

  const kept = sections.filter((s) => s.passageIds.length > 0);
  if (passages.length < 2) {
    throw new DocumentError("TOO_SHORT", "There is not enough in that document to cross-examine. Paste at least a few sentences.");
  }
  return { id, title: cleanTitle(input.title), sample: Boolean(input.sample), sections: kept, passages };
}

export function passageById(doc: SourceDocument, id: string): Passage | undefined {
  return doc.passages.find((p) => p.id === id);
}

/** True only for an id this exact document minted. */
export function isPassageOf(doc: SourceDocument, id: unknown): id is string {
  return typeof id === "string" && doc.passages.some((p) => p.id === id);
}
