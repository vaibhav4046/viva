import { NextRequest } from "next/server";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { cleanTitle } from "@/lib/intake/build";
import { PDF_MAX_BYTES, readPdfPages } from "@/lib/intake/pdf";
import { getStore } from "@/lib/store";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";

export const runtime = "nodejs";

const MAX_CHUNKS = 200;
const CHUNK_TARGET = 800;

/** The one size limit, stated from the constant that enforces it. */
function tooLarge(): Response {
  const mb = Math.round(PDF_MAX_BYTES / (1024 * 1024));
  return err("FILE_TOO_LARGE", `PDF must be ${mb} MB or smaller — that is all one request can carry.`, false, 413);
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

  // The platform rejects a body of roughly 4.5 MB with its own plain-text page,
  // so refuse over the real limit here — before buffering — rather than
  // advertising one three times larger than anything that can arrive.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) return done(tooLarge());

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
  if (file.size > PDF_MAX_BYTES) return done(tooLarge());

  const title = cleanTitle(file.name, "Upload");
  // One PDF reader for the whole app. This route used to carry its own copy —
  // no magic-byte check of its own, no page cap, and no timeout around
  // `getText()` — so the bug fixed in the intake path was still live here.
  const parsed = await readPdfPages(Buffer.from(await file.arrayBuffer()));
  if (!parsed.ok) {
    if (parsed.code === "FILE_TOO_LARGE") return done(tooLarge());
    if (parsed.code === "NOT_A_PDF") return done(err("BAD_FILE", "Only PDF files are accepted.", false, 415));
    if (parsed.code === "PARSE_TIMEOUT") {
      return done(err("PARSE_TIMEOUT", "That PDF took too long to read. Try a shorter one.", false, 504));
    }
    if (parsed.code === "NO_TEXT") {
      return done(err("BAD_FILE", "No extractable text found in that PDF.", false, 415));
    }
    return done(err("PARSE_FAILED", "That PDF could not be parsed here. Try a text-based PDF.", true, 422));
  }

  const normalized = parsed.pages.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
  const section = `Upload: ${title}`;
  const pieces = chunkText(normalized);

  const courseField = form.get("subjectId") ?? form.get("courseId");
  const store = getStore();
  const course = await resolveSubject(store, identity.userId, typeof courseField === "string" ? courseField : null).catch(subjectMissing);
  if (course instanceof Response) return done(course);
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
