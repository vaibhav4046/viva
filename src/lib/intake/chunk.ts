import type { SourceChunk } from "@/lib/types";

/**
 * Text in, passages out. 800 characters with 120 of overlap, cut on a word
 * boundary so no passage starts or ends mid-word, and never across a page
 * boundary — a citation has to be able to say which page it came from.
 */

export const CHUNK_CHARS = 800;
export const CHUNK_OVERLAP = 120;
export const MAX_CHUNKS = 120;

/** One unit of the input: a whole pasted note, or one page of a PDF. */
export type IntakePage = { text: string; page?: number };

export function normalizeText(raw: string): string {
  return raw
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/** Cut one page into overlapping windows, snapped to whitespace. */
function windows(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
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
 * Passages for one source, ordered, each carrying its page when the input had
 * one. `section` is what the source pane groups by, so it is the page label
 * for a PDF and the source title for pasted text.
 */
export function chunkPages(pages: IntakePage[], sourceId: string, fallbackSection: string): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let ordinal = 1;
  for (const page of pages) {
    for (const text of windows(page.text)) {
      if (chunks.length >= MAX_CHUNKS) return chunks;
      chunks.push({
        id: `${sourceId}_c${ordinal}`,
        sourceId,
        ordinal,
        text,
        locator: page.page ? { section: `Page ${page.page}`, page: page.page } : { section: fallbackSection },
      });
      ordinal += 1;
    }
  }
  return chunks;
}
