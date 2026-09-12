import { NextRequest } from "next/server";
import { resolveSubject } from "@/lib/courses/subject";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { getStore } from "@/lib/store";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CHUNKS = 200;
const CHUNK_TARGET = 800;

/** Filename is untrusted: basename + printable run, used for the title only. */
function sanitizeTitle(raw: unknown): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N} ._\-]+/gu, "").trim().replace(/\s+/g, " ");
  return clean.slice(0, 120) || "Upload";
}

function chunkText(normalized: string): string[] {
  const words = normalized.split(" ").filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length >= CHUNK_TARGET && cur) {
      chunks.push(cur);
      cur = w;
      if (chunks.length >= MAX_CHUNKS) return chunks;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS);
}

/**
 * POST /api/sources/upload — multipart form, file field "file".
 * Validates magic bytes %PDF (never MIME/filename), parses server-side with
 * pdf-parse, chunks to ~800-char paragraphs, persists scoped to the caller.
 */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["upload", clientIp(req)]), "upload");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Too many uploads. Wait a moment and try again.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return done(err("NO_FILE", "Attach a PDF file in the 'file' field.", false, 400));
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return done(err("NO_FILE", "Attach a PDF file in the 'file' field.", false, 400));
  }
  if (file.size > MAX_BYTES) {
    return done(err("FILE_TOO_LARGE", "PDF must be 10MB or smaller.", false, 413));
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (!(buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
    return done(err("BAD_FILE", "Only PDF files are accepted.", false, 415));
  }

  const title = sanitizeTitle(file.name);
  let text: string;
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    text = typeof result?.text === "string" ? result.text : "";
  } catch {
    return done(err("PARSE_FAILED", "That PDF could not be parsed here. Try a text-based PDF.", true, 422));
  }

  const normalized = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return done(err("BAD_FILE", "No extractable text found in that PDF.", false, 415));
  }
  const section = `Upload: ${title}`;
  const pieces = chunkText(normalized);

  const courseField = form.get("subjectId") ?? form.get("courseId");
  const store = getStore();
  const course = await resolveSubject(store, identity.userId, typeof courseField === "string" ? courseField : null);
  await store.seedCourse(identity.userId, course.id);
  const saved = await store.addSource(identity.userId, {
    title,
    type: "pdf",
    chunks: pieces.map((t) => ({ text: t, section })),
    courseId: course.id,
  });

  return done(Response.json({
    sourceId: saved.sourceId,
    title,
    chunks: saved.chunkIds.length,
    chunkIds: saved.chunkIds,
    courseId: course.id,
  }));
}
