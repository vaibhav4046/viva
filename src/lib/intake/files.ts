import { inflateRawSync } from "node:zlib";
import { decodeEntities } from "./html";

/**
 * The plain files a student already has: notes.txt, notes.md, essay.docx.
 *
 * PDFs keep their own reader (./pdf.ts) because they need a parser. These
 * three need almost nothing, so they get almost nothing: bytes in, headings
 * and paragraphs out, and a refusal when there is no text rather than a
 * subject built out of an empty file.
 */

export type FileDoc = { title: string; sections: { heading?: string; text: string }[]; chars: number };
export type FileReadResult = { ok: true; doc: FileDoc } | { ok: false; code: "UNSUPPORTED" | "NO_TEXT" };

export const TEXT_MAX_BYTES = 2 * 1024 * 1024;

const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && DOCX_MAGIC.every((b, i) => buf[i] === b);
}

/** `.txt`, `.md` and anything else that is really just characters. */
export function readTextDoc(raw: string, title: string): FileReadResult {
  const sections = splitMarkdown(raw);
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  if (chars < 200) return { ok: false, code: "NO_TEXT" };
  return { ok: true, doc: { title, sections, chars } };
}

/**
 * Markdown headings become passage sections, so a citation can say which part
 * of the file it came from. Everything else stays as the student typed it —
 * stripping emphasis or link syntax would change their words.
 */
function splitMarkdown(raw: string): { heading?: string; text: string }[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/```[\s\S]*?```/g, " ");
  const out: { heading?: string; text: string }[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (body.length >= 60) out.push(heading ? { heading, text: body } : { text: body });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const h = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[2].slice(0, 80);
      continue;
    }
    if (line.trim()) buffer.push(line.trim());
  }
  flush();
  return out;
}

/**
 * One entry out of a .docx, which is a zip with an XML document inside it.
 *
 * ponytail: reads the central directory for `word/document.xml` and inflates
 * that one entry — stored and deflated only. Zip64 archives and encrypted docs
 * are refused rather than half-read; upgrade path is a real zip library, which
 * is not worth a dependency for one file per student.
 */
function unzipEntry(buf: Buffer, wanted: string): Buffer | null {
  // End of central directory: signature 0x06054b50, scanned from the tail.
  const maxComment = 0xffff + 22;
  const from = Math.max(0, buf.length - maxComment);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) return null; // zip64: refused, not guessed at
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const end = start + compressed;
      if (end > buf.length) return null;
      const bytes = buf.subarray(start, end);
      if (method === 0) return Buffer.from(bytes);
      if (method !== 8) return null;
      try {
        return inflateRawSync(bytes);
      } catch {
        return null;
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Word paragraphs, in order. Styles, tracked changes and images are dropped. */
export function readDocx(buf: Buffer, title: string): FileReadResult {
  const xml = unzipEntry(buf, "word/document.xml");
  if (!xml) return { ok: false, code: "UNSUPPORTED" };
  const doc = xml.toString("utf8");
  const paragraphs: string[] = [];
  for (const m of doc.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const runs = [...m[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((r) => r[1]);
    if (!runs.length) continue;
    const text = decodeEntities(runs.join("")).replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
  }
  const sections: { heading?: string; text: string }[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join(" ").trim();
    if (body.length >= 60) sections.push(heading ? { heading, text: body } : { text: body });
    buffer = [];
  };
  for (const p of paragraphs) {
    // A short line on its own is a heading in every Word document a student
    // hands in; a long one is prose. Style names are not reliable enough here.
    if (p.length <= 70 && !/[.!?]$/.test(p)) {
      flush();
      heading = p.slice(0, 80);
      continue;
    }
    buffer.push(p);
  }
  flush();
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  if (chars < 200) return { ok: false, code: "NO_TEXT" };
  return { ok: true, doc: { title, sections, chars } };
}
