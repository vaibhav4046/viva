import { z } from "zod";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import type { IntakeDoc } from "@/lib/intake/build";
import { PDF_MAX_BYTES } from "@/lib/intake/pdf";
import { docFromFile, docFromUrl, type SourceFailure } from "@/lib/intake/sources";
import { checkLimit, limitKey } from "@/lib/limits";
import { cleanTitle } from "@/lib/redteam/document";
import { callerAddress } from "@/lib/redteam/http";
import { sentences } from "@/lib/redteam/text";
import { MAX_DOC_CHARS } from "@/lib/redteam/types";
import { err } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/redteam/import — turn a file or a link into text the user can read
 * and edit before they begin a review.
 *
 * Two shapes, and only these:
 *  - multipart/form-data with one `file` field (PDF, DOCX, TXT or MD);
 *  - JSON `{ "url": "https://…" }`, and nothing else in the object.
 *
 * Nothing is stored. The response is `{ title, text, chars, truncated,
 * sourceType }`, and the browser puts `text` in the same box a paste goes in.
 * The review that follows goes through POST /api/redteam/session like any other.
 *
 * The reading is not done here. `docFromFile` and `docFromUrl` are the intake
 * layer /subjects already trusts: it sniffs bytes instead of believing names,
 * caps what a zip may inflate to, times a PDF out, and refuses a private
 * address before it fetches. This file adds a byte cap that holds while the
 * body is still arriving, the RedTeam rate limit, and the step from passages to
 * the Markdown the RedTeam document builder reads.
 *
 * `sourceType` is the intake's own label: "pdf", "doc", "text" or "web".
 */

/**
 * The most an upload request may carry: the same ceiling, counted the same way,
 * as /api/subjects/create. It is the whole body, so it includes the few hundred
 * bytes of multipart framing around the file.
 */
const MAX_UPLOAD_BYTES = PDF_MAX_BYTES;

/** A link is one short string. Anything bigger is not one. */
const MAX_LINK_BODY = 8 * 1024;

/**
 * Extensions the picker offers, plus the two spellings the intake also strips.
 * A name with no extension is left to the bytes; a name with one that is not
 * here is refused before anything is read.
 */
const SUPPORTED_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "markdown", "text"]);

const LinkBody = z.object({ url: z.string().max(2048) }).strict();

const limitedResponse = (retryAfterSec: number) =>
  Response.json(
    { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );

export async function POST(req: Request): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  const reply = (res: Response): Response => {
    res.headers.set("Cache-Control", "no-store");
    return withIdentityCookie(res, setCookie);
  };

  // Both keys, the way handle() in src/lib/redteam/http.ts does it: the address
  // (which ignores an x-forwarded-for the caller wrote) and the cookie identity.
  // The buckets are this route's own, so importing two documents does not spend
  // the budget for starting the review that follows.
  for (const bucket of [
    ["redteam-import", "upload", callerAddress(req)],
    ["redteam-import-did", "upload", identity.userId],
  ]) {
    const rl = checkLimit(limitKey(bucket), "upload");
    if (!rl.ok) return reply(limitedResponse(rl.retryAfterSec));
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    const res = contentType.toLowerCase().includes("multipart/form-data") ? await fromUpload(req, contentType) : await fromLink(req);
    return reply(res);
  } catch (e) {
    // The message is logged, cut short, and never sent. A stack or a path is
    // for whoever runs this, not for the person who chose the file.
    console.error("redteam.import.failed", (e as Error)?.message?.slice(0, 200));
    return reply(err("IMPORT_FAILED", "That could not be read. Try another file, or paste the text.", true, 500));
  }
}

async function fromUpload(req: Request, contentType: string): Promise<Response> {
  const body = await readCapped(req, MAX_UPLOAD_BYTES);
  if (body === null) return tooLarge();

  // Parsed from the bytes already in hand, so the cap above is the one that
  // decided how much of the request was ever read.
  let form: FormData;
  try {
    form = await new Response(body as unknown as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return err("BAD_REQUEST", "That upload could not be read. Try again.", false, 400);
  }

  const entries = form.getAll("file");
  if (entries.length > 1) return err("BAD_REQUEST", "Import one file at a time.", false, 400);
  const file = entries[0];
  if (!(file instanceof File)) return err("NO_FILE", "Choose a file to import, or paste the text.", false, 400);

  // Only the last path segment, which is all a title needs and all a name owes.
  const name = (file.name.split(/[\\/]/).pop() ?? "").trim();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension && !SUPPORTED_EXTENSIONS.has(extension)) {
    return err("UNSUPPORTED_TYPE", "VIVA can read PDF, Word (.docx), text and Markdown files. Save it as one of those, or paste the text.", false, 415);
  }

  const read = await docFromFile(name, Buffer.from(await file.arrayBuffer()));
  return read.ok ? imported(read.doc) : refused(read.error);
}

async function fromLink(req: Request): Promise<Response> {
  const body = await readCapped(req, MAX_LINK_BODY);
  if (body === null) return err("TOO_LARGE", "That request is too large.", false, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return err("BAD_REQUEST", "Expected a file or a JSON link.", false, 400);
  }
  const shaped = LinkBody.safeParse(parsed);
  if (!shaped.success) return err("BAD_REQUEST", "That request is not shaped right.", false, 400);
  const url = shaped.data.url.trim();
  if (!url) return err("BAD_REQUEST", "Paste the address of the page you want to import.", false, 400);

  // The intake fetcher owns everything about reaching a stranger's address:
  // scheme, credentials, every hop resolved and refused if it is private, a
  // byte cap, a time cap. Nothing is fetched here.
  const read = await docFromUrl(url);
  return read.ok ? imported(read.doc) : refused(read.error);
}

/** What the intake said, in the code, sentence and status it said it. */
function refused(failure: SourceFailure): Response {
  return err(failure.code, failure.message, failure.status >= 500 || failure.code === "UNREACHABLE", failure.status);
}

function tooLarge(): Response {
  const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  return err(
    "FILE_TOO_LARGE",
    `That file is over ${mb} MB, which is more than VIVA can take in one request. Try a smaller one, or paste the part you need to defend.`,
    false,
    413
  );
}

function imported(doc: IntakeDoc): Response {
  const { text, truncated } = toMarkdown(doc);
  if (!text) {
    return err("NO_TEXT_IN_FILE", "There is no readable text there. Paste the text instead.", false, 422);
  }
  return Response.json({ title: cleanTitle(doc.title), text, chars: text.length, truncated, sourceType: doc.type });
}

/**
 * Read at most `max` bytes. `null` means there were more, and reading stopped.
 *
 * The declared length is checked first, so an honest oversize upload is refused
 * without a byte of it being read. It is only a claim, though, and a chunked
 * body has none, so the count is kept while reading too and the stream is
 * cancelled the moment it passes the cap.
 */
async function readCapped(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------- Markdown */

/**
 * A paragraph is broken near this length, at the end of a sentence. The
 * intake hands over a whole section (or a whole PDF page) as one unbroken
 * line, and the document builder cuts any line over 4,000 characters at a fixed
 * offset, which can land inside a word. Cutting here first, between sentences,
 * means it never has to.
 */
const SOFT_PARAGRAPH = 1_200;

/** No paragraph is longer than this, even when one "sentence" runs on that far. */
const HARD_PARAGRAPH = 3_000;

/** Control characters other than tab and newline are noise in a document, and a NUL is worse. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const collapse = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** One long run of text as paragraphs that end where a sentence ends. */
function paragraphsOf(raw: string): string[] {
  const flat = collapse(raw);
  const out: string[] = [];
  let current = "";
  const add = (piece: string) => {
    if (current && current.length + 1 + piece.length > SOFT_PARAGRAPH) {
      out.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };
  for (const s of flat ? sentences(flat) : []) {
    let rest = s;
    while (rest.length > HARD_PARAGRAPH) {
      let cut = rest.lastIndexOf(" ", HARD_PARAGRAPH);
      if (cut < HARD_PARAGRAPH / 2) {
        // No space to cut at (Chinese and Japanese have none): cut at the limit,
        // but never between the two halves of one character.
        cut = HARD_PARAGRAPH;
        const last = rest.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
      }
      add(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) add(rest);
  }
  if (current) out.push(current);
  return out;
}

/**
 * The document as the RedTeam builder reads Markdown: `## <label>` for a
 * section, or for a PDF page with no section of its own, then its paragraphs.
 * A heading is never written without at least one paragraph under it.
 *
 * Over the cap it is cut at a paragraph boundary, so the text ends on a whole
 * paragraph rather than in the middle of a sentence, and `truncated` says so.
 */
function toMarkdown(doc: IntakeDoc): { text: string; truncated: boolean } {
  let text = "";
  for (const page of doc.pages) {
    const paragraphs = paragraphsOf(page.text);
    if (!paragraphs.length) continue;
    const label = (collapse(page.section ?? "") || (page.page != null ? `Page ${page.page}` : "")).slice(0, 120);
    for (const [i, paragraph] of paragraphs.entries()) {
      const block = i === 0 && label ? `## ${label}\n\n${paragraph}` : paragraph;
      const next = text ? `${text}\n\n${block}` : block;
      if (next.length > MAX_DOC_CHARS) return { text, truncated: true };
      text = next;
    }
  }
  return { text, truncated: false };
}
