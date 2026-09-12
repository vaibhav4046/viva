import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { clientIp, withIdentityCookie } from "@/lib/http";
import type { Subject } from "@/lib/courses/types";
import { buildSubject, cleanTitle, type IntakeDoc, type IntakeInput } from "@/lib/intake/build";
import { PDF_MAX_BYTES } from "@/lib/intake/pdf";
import { docFromFile, docFromUrl, MAX_DOCS } from "@/lib/intake/sources";
import { checkLimit, limitKey } from "@/lib/limits";
import { getStore, storeDurability } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/subjects/create — build one subject, inline, and say so as it goes.
 *
 * The response is newline-delimited JSON streamed over the POST itself: one
 * `{"line": "…"}` per step while the work happens, then a final `{"subject":…}`
 * or `{"error":…}`. No job queue, no polling, and the page can render each line
 * the moment it arrives because each line is a sentence, not a status code.
 *
 * Ownership: the subject is written against the cookie identity and read back
 * only through user-scoped queries, so nobody else can open it.
 */

type Line =
  | { line: string }
  | {
      subject: {
        id: string;
        title: string;
        builtBy: string | null;
        concepts: number;
        questions: number;
        passages: number;
        /** False when nothing durable is behind this deployment. */
        durable: boolean;
        /** The sentence to show beside the result when it is not durable. */
        storageNote: string | null;
      };
      /**
       * The whole built subject, for the browser to keep.
       *
       * A judge built a subject, was told "is ready · 10 concepts · 8
       * questions", and then every one of eleven reads that followed came back
       * without it — because with no database the write went to one lambda's
       * /tmp. The browser is the authority now, so the subject leaves with the
       * response and comes back through POST /api/learner/sync on the next
       * load, which is what makes "is ready" a true sentence.
       */
      record: Subject;
      redirect: string;
    }
  | { error: { code: string; message: string } };

/**
 * The three sentences the student sees when there is nowhere durable to write.
 *
 * They used to say the subject might be gone on the next page load, which was
 * true and is not any more: the subject travels back in the response, the
 * browser keeps it, and it is handed in again on the next load. What is still
 * true is the part these now say — this browser, not this account.
 */
const NO_DATABASE = "Before you start: VIVA keeps what you build in this browser, so it comes back here and not on your other devices.";
const KEEPING = "Keeping it in this browser — that is where your subjects live.";
const NOT_KEPT = "Kept in this browser. Open VIVA here again and it is waiting; open it somewhere else and it will not be.";

function encoder(controller: ReadableStreamDefaultController<Uint8Array>) {
  const enc = new TextEncoder();
  return (payload: Line) => controller.enqueue(enc.encode(`${JSON.stringify(payload)}\n`));
}


export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["subject-create", clientIp(req)]), "upload");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "That is a lot of subjects at once. Wait a moment and try again.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let input: IntakeInput;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    // Refuse an oversize body BEFORE buffering it. The platform would reject it
    // anyway with a plain-text page this app cannot phrase, so the only way the
    // student gets a sentence they can act on is to answer first.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) return done(tooLarge());
    let form: FormData;
    try { form = await req.formData(); } catch { return done(bad("BAD_REQUEST", "VIVA could not read that upload.")); }
    const files = form.getAll("file").filter((f): f is File => f instanceof File).slice(0, MAX_DOCS);
    if (!files.length) return done(bad("NO_FILE", "Attach a file, or paste your notes instead."));
    if (files.reduce((n, f) => n + f.size, 0) > PDF_MAX_BYTES) return done(tooLarge());

    const docs: IntakeDoc[] = [];
    for (const file of files) {
      const read = await docFromFile(file.name, Buffer.from(await file.arrayBuffer()));
      // One unreadable file fails the request. Building a subject out of the
      // other three and saying nothing about the one that did not open is how
      // a student ends up revising from half their material without knowing.
      if (!read.ok) return done(bad(read.error.code, read.error.message, read.error.status));
      docs.push(read.doc);
    }
    const title = cleanTitle(form.get("title") || files[0].name, "Your file");
    input = docs.length === 1 && docs[0].type === "pdf"
      ? { kind: "pdf", title, pages: docs[0].pages }
      : { kind: "docs", title, origin: "file", docs };
  } else {
    let body: { kind?: string; title?: string; text?: string; url?: string; urls?: unknown };
    try { body = (await req.json()) as typeof body; } catch { return done(bad("BAD_REQUEST", "Expected JSON.")); }
    const kind = body.kind === "named" ? "named" : body.kind === "url" ? "url" : "paste";
    const title = cleanTitle(body.title, kind === "named" ? "Your subject" : "Your notes");
    if (kind === "named") {
      if (!body.title || String(body.title).trim().length < 3) return done(bad("BAD_REQUEST", "Give the topic a name first."));
      input = { kind: "named", title };
    } else if (kind === "url") {
      const urls = [...(Array.isArray(body.urls) ? body.urls : []), ...(body.url ? [body.url] : [])]
        .map((u) => String(u ?? "").trim())
        .filter(Boolean)
        .slice(0, MAX_DOCS);
      if (!urls.length) return done(bad("BAD_REQUEST", "Paste the address of the page you want to study."));
      const docs: IntakeDoc[] = [];
      for (const url of urls) {
        const read = await docFromUrl(url);
        if (!read.ok) return done(bad(read.error.code, read.error.message, read.error.status));
        docs.push(read.doc);
      }
      input = {
        kind: "docs",
        // The page names itself unless the student named the subject. The
        // slashes go first: cleanTitle treats them as path separators and
        // would turn "Photosynthesis / Biology" into "Biology".
        title: body.title ? title : cleanTitle(docs[0].title.replace(/[\\/]+/g, " · "), "That page"),
        origin: "url",
        docs,
      };
    } else {
      const text = String(body.text ?? "");
      if (text.trim().length < 200) return done(bad("BAD_REQUEST", "Paste a bit more — a few paragraphs is enough."));
      input = { kind: "paste", title, text: text.slice(0, 200_000) };
    }
  }

  /*
   * Storage honesty, checked before the work rather than claimed after it.
   *
   * A judge pasted 1,500 words, watched "Saving it to your subjects…", was
   * shown 10 concepts / 8 questions / 12 passages, and then the subject was
   * absent from all eleven reads that followed — because with no database
   * configured the file store is one lambda's /tmp. The storage itself needs a
   * DATABASE_URL, which this route cannot conjure; what it CAN do is stop
   * promising something it is not going to deliver.
   */
  const { durable } = await storeDurability();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = encoder(controller);
      try {
        if (!durable) send({ line: NO_DATABASE });
        const result = await buildSubject(input, identity.userId, (line) => send({ line }));
        if (!result.ok) {
          // A refusal is a normal outcome, not a crash: say why, in a sentence,
          // and let the single close in `finally` end the stream.
          send({ error: { code: result.error.code, message: result.error.message } });
          return;
        }
        send({ line: durable ? "Saving it to your subjects…" : KEEPING });
        const store = getStore();
        await store.ensureUser(identity.userId);
        await store.saveSubject(identity.userId, result.subject);
        if (!durable) send({ line: NOT_KEPT });
        const s = result.subject;
        send({
          subject: {
            id: s.id,
            title: s.title,
            builtBy: s.builtBy,
            concepts: s.concepts.length,
            questions: s.examQuestions.length,
            passages: s.sources.reduce((n, src) => n + src.chunks.length, 0),
            durable,
            storageNote: durable ? null : NOT_KEPT,
          },
          record: s,
          redirect: `/study?subject=${encodeURIComponent(s.id)}`,
        });
      } catch (error) {
        console.error("[subjects/create] failed:", error);
        send({ error: { code: "INTAKE_FAILED", message: "Something broke while building that subject. Nothing was saved — try again." } });
      } finally {
        controller.close();
      }
    },
  });

  return done(new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  }));
}

function bad(code: string, message: string, status = 400): Response {
  return Response.json({ error: { code, message, retryable: false } }, { status });
}

/** One sentence for the one size limit, derived from the constant. */
function tooLarge(): Response {
  const mb = Math.round(PDF_MAX_BYTES / (1024 * 1024));
  return bad(
    "FILE_TOO_LARGE",
    `That PDF is over ${mb} MB, which is more than VIVA can take in one request. Try a smaller one, or paste the part you are studying.`,
    413
  );
}
