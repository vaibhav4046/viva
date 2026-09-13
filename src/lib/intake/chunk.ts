import type { SourceChunk } from "@/lib/types";

/**
 * Text in, passages out. Cut where the writer cut — at their paragraphs, their
 * bullet lists, their numbered steps — and only fall back to counting
 * characters inside a paragraph too long to be a passage on its own. Never
 * across a page boundary: a citation has to be able to say which page it came
 * from.
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
    // A Windows line ending is ONE break, not two. `/\r/` alone turned every
    // "\r\n" into a blank line, so a paste off a Windows machine had a
    // paragraph break between every pair of lines — invisible while passages
    // were cut by character count, and a citation that miscounts the
    // student's own paragraphs now that they are cut where the writer cut.
    .replace(/\r\n?/g, "\n")
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
 * Cut one paragraph that is longer than a whole passage, on its sentences.
 *
 * Passages used to be cut at 800 characters and snapped to the nearest space,
 * so a judge reading their own notes back got "Passage 2: correct validity
 * check passes a (min, max) range down the recursion" — a passage opening on
 * the second half of a clause. Whole sentences are packed instead.
 *
 * This is now the only place that guesses at a boundary, so it is the only
 * place that still carries a seam: the next passage re-opens with the last
 * whole sentences of this one, because a claim straddling a cut nobody
 * intended has to stay retrievable whole from one side of it. A single
 * sentence longer than a passage is the one case left that cuts mid-clause.
 */
function sentenceWindows(clean: string): string[] {
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

/**
 * The blocks the writer left: paragraphs, separated by a blank line. A run of
 * bullets or numbered steps with no blank line between them is one block,
 * which is the point — a list is one idea and belongs in one passage.
 */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A passage, and which of the document's paragraphs it covers whole. */
type Window = { text: string; paragraphs: [number, number] | null };

/**
 * Pack whole paragraphs into passages.
 *
 * A judge pasted their own notes and got six passages of 758, 787, 743, 771,
 * 745 and 430 characters: one ended "Three things fall straight out of that
 * equation: 1." and the next opened with it, one ran from the turnover number
 * through to the intercepts of a Lineweaver-Burk plot, and the last was a
 * remainder. Whole sentences did not fix that, because the cut was never
 * wrong by a few words — it was in a place the writer had not put one. Their
 * own blank lines are a better boundary than any character count, and they
 * cost nothing to read.
 *
 * A paragraph longer than a whole passage still has to be cut somewhere, and
 * that case alone keeps the sentence packing and the seam.
 *
 * `base` is how many paragraphs of this document came before this page, so the
 * numbers a citation shows count through the whole thing rather than
 * restarting under every heading.
 */
function windows(text: string, base: number): { passages: Window[]; paragraphs: number } {
  const blocks = paragraphsOf(text);
  const passages: Window[] = [];
  let buf: string[] = [];
  let len = 0;
  let first = 0;
  let last = 0;
  const flush = () => {
    if (buf.length) passages.push({ text: buf.join(" "), paragraphs: [first, last] });
    buf = [];
    len = 0;
  };

  for (const [i, block] of blocks.entries()) {
    const n = base + i + 1;
    if (block.length > CHUNK_CHARS) {
      flush();
      // Cut inside one paragraph: the pieces cover no whole paragraph of it,
      // so they carry no paragraph number. "Paragraph 4" three times running
      // is true and useless, and on a document that is one unbroken block it
      // would be worse than saying nothing.
      for (const piece of sentenceWindows(block)) passages.push({ text: piece, paragraphs: null });
      continue;
    }
    if (len + block.length + 1 > CHUNK_CHARS) flush();
    if (!buf.length) first = n;
    last = n;
    buf.push(block);
    len += block.length + 1;
  }
  flush();
  return { passages: passages.filter((p) => p.text), paragraphs: blocks.length };
}

/**
 * Section first, then the page number, then where in the document it is, and
 * only then the source's own name.
 *
 * Every passage of a paste used to be stamped with the source's own name —
 * "§Your notes", the same string on all seven of them, which locates nothing.
 * A student checking whether they were quoted correctly needs somewhere to
 * look: their heading if they wrote one, and failing that the paragraph,
 * counted off their own blank lines, which is what a page number is for a PDF.
 * Nothing here is invented. A document that offers neither still gets its own
 * name rather than a number implying a precision it has not got.
 */
function locatorFor(page: IntakePage, at: [number, number] | null, fallbackSection: string): SourceChunk["locator"] {
  const section = page.section?.trim();
  if (section && page.page) return { section, page: page.page };
  if (section) return { section };
  if (page.page) return { section: `Page ${page.page}`, page: page.page };
  if (at) return { section: at[0] === at[1] ? `Paragraph ${at[0]}` : `Paragraphs ${at[0]}–${at[1]}` };
  return { section: fallbackSection };
}

/**
 * Passages for one source, ordered, each carrying its page when the input had
 * one. `section` is what the source pane groups by, so it is the heading for a
 * web page or chapter, the page label for a PDF, and the paragraphs it covers
 * for pasted text that came with no headings at all.
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
  let paragraphs = 0;
  for (const page of pages) {
    const cut = windows(page.text, paragraphs);
    paragraphs += cut.paragraphs;
    for (const passage of cut.passages) {
      if (chunks.length >= limit) return chunks;
      chunks.push({
        id: `${sourceId}_c${ordinal}`,
        sourceId,
        ordinal,
        text: passage.text,
        locator: locatorFor(page, passage.paragraphs, fallbackSection),
      });
      ordinal += 1;
    }
  }
  return chunks;
}
