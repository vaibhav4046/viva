import type { IntakePage } from "./chunk";

/**
 * PDF text, page by page.
 *
 * pdf-parse is externalised in next.config.ts: bundling it breaks its worker
 * requires and turns every valid PDF into a parse failure.
 */

/**
 * The real ceiling, not the one we wish we had.
 *
 * This was 15 MB in three places — the UI copy, this constant and a carefully
 * written FILE_TOO_LARGE message — and all three were unreachable: the
 * platform rejects a request body of roughly 4.5 MB with its own plain-text
 * page before any of this code runs, so every upload between 4.5 and 15 MB (a
 * lecture-slide deck, i.e. the single most likely file a student picks) failed
 * with a message that invited a retry of something that could never work.
 *
 * 4 MB leaves headroom under the platform limit. Raising it again means
 * uploading straight to blob storage and handing this function a URL, which is
 * a real change rather than a bigger number.
 */
export const PDF_MAX_BYTES = 4 * 1024 * 1024;

/** Pages parsed at most. Capped BEFORE parsing, so page 900 costs nothing. */
export const PDF_MAX_PAGES = 120;

/**
 * The only place in the app where untrusted bytes drive an unbounded loop. A
 * PDF crafted to be pathological used to burn the whole 60 s function budget
 * inside pdfjs and return the platform's timeout page instead of one of this
 * codebase's coded errors.
 */
export const PDF_TIMEOUT_MS = 20_000;

export type PdfReadResult =
  | { ok: true; pages: IntakePage[] }
  | { ok: false; code: "NOT_A_PDF" | "PARSE_FAILED" | "PARSE_TIMEOUT" | "NO_TEXT" | "FILE_TOO_LARGE" };

/** Magic bytes, never the filename or the declared MIME type. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

/** Reject, never wait forever. Resolves to a code instead of hanging. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readPdfPages(buf: Buffer): Promise<PdfReadResult> {
  if (buf.length > PDF_MAX_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (!looksLikePdf(buf)) return { ok: false, code: "NOT_A_PDF" };
  let pages: { num: number; text: string }[];
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const result = await withTimeout(parser.getText({ first: PDF_MAX_PAGES }), PDF_TIMEOUT_MS);
      if (result === "timeout") return { ok: false, code: "PARSE_TIMEOUT" };
      pages = Array.isArray(result?.pages) ? result.pages : [];
    } finally {
      // Destroy even on the timeout path: the parse is still running and holds
      // a worker plus the whole buffer until it is torn down.
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
