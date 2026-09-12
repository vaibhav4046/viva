import type { IntakeDoc } from "./build";
import { readDocx, readTextDoc, looksLikeZip, TEXT_MAX_BYTES } from "./files";
import { looksLikePdf, readPdfPages } from "./pdf";
import { fetchReadableUrl } from "./url";
import type { Readable } from "./html";

/**
 * Everything a student can point VIVA at, turned into documents it can read.
 *
 * One place, so the rules are the same wherever a source comes from: the
 * document keeps its own title and its own provenance, a passage keeps the
 * heading it sat under, and a source VIVA cannot read is refused with a
 * sentence instead of being turned into an empty subject.
 */

export type SourceFailure = { code: string; message: string; status: number };
export type SourceResult = { ok: true; doc: IntakeDoc } | { ok: false; error: SourceFailure };

/** How many separate documents may compose one subject in a single request. */
export const MAX_DOCS = 4;

function readableToDoc(readable: Readable, title: string, type: string, url?: string): IntakeDoc {
  return {
    title,
    type,
    url,
    pages: readable.sections.map((s) => ({ text: s.text, section: s.heading })),
    fallbackSection: title,
  };
}

/** A page on the public web. The citation keeps the page's own title and URL. */
export async function docFromUrl(raw: string): Promise<SourceResult> {
  const fetched = await fetchReadableUrl(raw);
  if (!fetched.ok) {
    const status = fetched.code === "BLOCKED_HOST" || fetched.code === "BAD_URL" ? 400 : fetched.code === "TOO_LARGE" ? 413 : 422;
    return { ok: false, error: { code: fetched.code, message: fetched.message, status } };
  }
  return { ok: true, doc: readableToDoc(fetched.readable, fetched.title, "web", fetched.url) };
}

const TOO_BIG = (mb: number): SourceFailure => ({
  code: "FILE_TOO_LARGE",
  message: `That file is over ${mb} MB, which is more than VIVA can take in one request. Try a smaller one, or paste the part you are studying.`,
  status: 413,
});

/**
 * An uploaded file, dispatched on what the bytes actually are rather than on
 * what the name claims. A .docx renamed to .pdf is still a .docx.
 */
export async function docFromFile(name: string, bytes: Buffer): Promise<SourceResult> {
  const title = name.replace(/\.(pdf|docx|txt|md|markdown|text)$/i, "").trim() || "Your file";

  if (looksLikePdf(bytes)) {
    const parsed = await readPdfPages(bytes);
    if (!parsed.ok) return { ok: false, error: pdfFailure(parsed.code) };
    return { ok: true, doc: { title, type: "pdf", pages: parsed.pages, fallbackSection: title } };
  }

  if (looksLikeZip(bytes)) {
    const read = readDocx(bytes, title);
    if (!read.ok) {
      return {
        ok: false,
        error: read.code === "NO_TEXT"
          ? { code: "NO_TEXT_IN_FILE", message: "There is no readable text in that document. Paste the text instead and VIVA will read that.", status: 422 }
          : { code: "BAD_FILE", message: "VIVA could not open that document. Save it as a .docx, a PDF or plain text and try again.", status: 415 },
      };
    }
    return { ok: true, doc: { title, type: "doc", pages: pagesFrom(read.doc.sections), fallbackSection: title } };
  }

  if (bytes.length > TEXT_MAX_BYTES) return { ok: false, error: TOO_BIG(Math.round(TEXT_MAX_BYTES / (1024 * 1024))) };
  const text = bytes.toString("utf-8");
  // A binary file decoded as text is mostly replacement characters. Say it is
  // the wrong kind of file rather than building a subject out of noise.
  const junk = (text.match(/�/g) ?? []).length;
  if (junk > text.length / 200) {
    return {
      ok: false,
      error: { code: "BAD_FILE", message: "VIVA can read PDFs, Word documents and plain text. That file is something else — paste the text instead.", status: 415 },
    };
  }
  const read = readTextDoc(text, title);
  if (!read.ok) {
    return { ok: false, error: { code: "NO_TEXT_IN_FILE", message: "There is almost nothing in that file. Paste your notes instead and VIVA will read those.", status: 422 } };
  }
  return { ok: true, doc: { title, type: "text", pages: pagesFrom(read.doc.sections), fallbackSection: title } };
}

function pagesFrom(sections: { heading?: string; text: string }[]) {
  return sections.map((s) => ({ text: s.text, section: s.heading }));
}

function pdfFailure(code: string): SourceFailure {
  if (code === "FILE_TOO_LARGE") return TOO_BIG(4);
  if (code === "PARSE_TIMEOUT") {
    return { code, message: "That PDF took too long to read. Try a shorter one, or paste the part you are studying.", status: 504 };
  }
  if (code === "NO_TEXT") {
    return {
      code: "NO_TEXT_IN_PDF",
      message:
        "There is no text in that PDF — it looks like scanned pages or images. VIVA will not guess at what they say. Paste the text instead and it will read that.",
      status: 422,
    };
  }
  if (code === "NOT_A_PDF") {
    return { code: "BAD_FILE", message: "VIVA could not tell what kind of file that is. Upload a PDF, a Word document or plain text.", status: 415 };
  }
  return { code: "PARSE_FAILED", message: "VIVA could not open that PDF. Try another file, or paste the text.", status: 422 };
}
