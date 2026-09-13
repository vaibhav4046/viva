import type { SourceChunk } from "@/lib/types";

/**
 * Text in, passages out. 800 characters with 120 of overlap, cut on a word
 * boundary so no passage starts or ends mid-word, and never across a page
 * boundary — a citation has to be able to say which page it came from.
 */

export const CHUNK_CHARS = 800;
export const CHUNK_OVERLAP = 120;
export const MAX_CHUNKS = 120;

/**
 * One unit of the input: a whole pasted note, one page of a PDF, or one
 * headed section of a web page, a Word file or a textbook chapter. `section`
 * is what a citation shows the student, so it carries the heading the passage
 * actually sat under when the input had one.
 */
export type IntakePage = { text: string; page?: number; section?: string };

export function normalizeText(raw: string): string {
  return raw
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/** Last resort: prose with no sentence in it, cut on whitespace. */
function wordWindows(clean: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_CHARS);
    if (end < clean.length) {
      const space = clean.lastIndexOf(" ", end);
      if (space > start + CHUNK_CHARS / 2) end = space;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    const nextStart = end - CHUNK_OVERLAP;
    const space = clean.indexOf(" ", nextStart);
    start = space > nextStart && space < end ? space + 1 : Math.max(nextStart, start + 1);
  }
  return out.filter(Boolean);
}

/**
 * Cut one page into passages that begin where a sentence begins.
 *
 * They used to be cut at 800 characters and snapped to the nearest space, so
 * a judge reading their own notes back got "Passage 2: correct validity check
 * passes a (min, max) range down the recursion" — a passage opening on the
 * second half of a clause, repeating the tail of the one above it. Whole
 * sentences are packed instead, and the seam that keeps a straddling claim
 * retrievable is carried as whole sentences too rather than as a hundred
 * characters cut wherever they landed. A single sentence longer than a whole
 * passage still has to be cut somewhere, and that is the only case left that
 * cuts mid-clause.
 */
function windows(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];

  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (buf.length) out.push(buf.join(" "));
  };
  // Re-open the next passage with the last whole sentences of this one.
  const carry = () => {
    const keep: string[] = [];
    let n = 0;
    for (let i = buf.length - 1; i >= 0 && n + buf[i].length + 1 <= CHUNK_OVERLAP; i--) {
      keep.unshift(buf[i]);
      n += buf[i].length + 1;
    }
    buf = keep;
    len = n;
  };

  for (const sentence of clean.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length > CHUNK_CHARS) {
      flush();
      buf = [];
      len = 0;
      for (const piece of wordWindows(s)) out.push(piece);
      continue;
    }
    if (len + s.length + 1 > CHUNK_CHARS && buf.length) {
      flush();
      carry();
      // The carried seam can already be most of a passage; drop it rather
      // than run over the ceiling.
      if (len + s.length + 1 > CHUNK_CHARS) {
        buf = [];
        len = 0;
      }
    }
    buf.push(s);
    len += s.length + 1;
  }
  flush();
  return out.filter(Boolean);
}

/** Section first, then the page number, then the source's own name. */
function locatorFor(page: IntakePage, fallbackSection: string): SourceChunk["locator"] {
  const section = page.section?.trim();
  if (section && page.page) return { section, page: page.page };
  if (section) return { section };
  if (page.page) return { section: `Page ${page.page}`, page: page.page };
  return { section: fallbackSection };
}

/**
 * Passages for one source, ordered, each carrying its page when the input had
 * one. `section` is what the source pane groups by, so it is the heading for a
 * web page or chapter, the page label for a PDF, and the source title for
 * pasted text.
 */
export function chunkPages(
  pages: IntakePage[],
  sourceId: string,
  fallbackSection: string,
  /**
   * How many passages to cut before stopping. The default is the ceiling a
   * subject ships with; `sourcesFrom` asks for one more than it intends to
   * keep, which is the only way to tell "this document fitted" from "this
   * document was cut off here" — and the student is owed that difference.
   */
  limit: number = MAX_CHUNKS
): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let ordinal = 1;
  for (const page of pages) {
    for (const text of windows(page.text)) {
      if (chunks.length >= limit) return chunks;
      chunks.push({
        id: `${sourceId}_c${ordinal}`,
        sourceId,
        ordinal,
        text,
        locator: locatorFor(page, fallbackSection),
      });
      ordinal += 1;
    }
  }
  return chunks;
}
