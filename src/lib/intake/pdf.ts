import type { IntakePage } from "./chunk";

/**
 * PDF text, page by page.
 *
 * pdf-parse is externalised in next.config.ts: bundling it breaks its worker
 * requires and turns every valid PDF into a parse failure.
 */

export const PDF_MAX_BYTES = 15 * 1024 * 1024;

export type PdfReadResult =
  | { ok: true; pages: IntakePage[] }
  | { ok: false; code: "NOT_A_PDF" | "PARSE_FAILED" | "NO_TEXT" };

/** Magic bytes, never the filename or the declared MIME type. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

export async function readPdfPages(buf: Buffer): Promise<PdfReadResult> {
  if (!looksLikePdf(buf)) return { ok: false, code: "NOT_A_PDF" };
  let pages: { num: number; text: string }[];
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      pages = Array.isArray(result?.pages) ? result.pages : [];
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return { ok: false, code: "PARSE_FAILED" };
  }
  const withText = pages
    .map((p) => ({ page: p.num, text: (p.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((p) => p.text.length > 0);
  // A scanned PDF parses fine and yields nothing. Saying so is the only honest
  // answer; inventing a summary of pages we could not read would not be.
  if (withText.reduce((n, p) => n + p.text.length, 0) < 200) return { ok: false, code: "NO_TEXT" };
  return { ok: true, pages: withText };
}
