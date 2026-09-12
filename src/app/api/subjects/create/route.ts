import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { buildSubject, cleanTitle, type IntakeInput } from "@/lib/intake/build";
import { PDF_MAX_BYTES, readPdfPages } from "@/lib/intake/pdf";
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
        /** False when this subject may not be readable on the next request. */
        durable: boolean;
        /** The sentence to show beside the result when it is not durable. */
        storageNote: string | null;
      };
      redirect: string;
    }
  | { error: { code: string; message: string } };

/**
 * The three sentences the student sees when there is nowhere durable to write.
 * They say what is true — no database, this page only, may be gone on reload —
 * and they arrive before and after the work rather than instead of it.
 */
const NO_DATABASE = "Before you start: VIVA has no database here, so a subject you build may not survive the next page load.";
const KEEPING = "Keeping it for this session — there is no database here to save it to.";
const NOT_KEPT = "Built, but not stored anywhere lasting: if it is gone when you come back, that is why.";

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
    const file = form.get("file");
    if (!(file instanceof File)) return done(bad("NO_FILE", "Attach a PDF, or paste your notes instead."));
    if (file.size > PDF_MAX_BYTES) return done(tooLarge());
    const parsed = await readPdfPages(Buffer.from(await file.arrayBuffer()));
    if (!parsed.ok) {
      if (parsed.code === "FILE_TOO_LARGE") return done(tooLarge());
      if (parsed.code === "NOT_A_PDF") return done(bad("BAD_FILE", "That is not a PDF. Upload a PDF, or paste your notes instead.", 415));
      if (parsed.code === "PARSE_TIMEOUT") {
        return done(bad(
          "PARSE_TIMEOUT",
          "That PDF took too long to read. Try a shorter one, or paste the part you are studying.",
          504
        ));
      }
      if (parsed.code === "NO_TEXT") {
        return done(bad(
          "NO_TEXT_IN_PDF",
          "There is no text in that PDF — it looks like scanned pages or images. VIVA will not guess at what they say. Paste the text instead and it will read that.",
          422
        ));
      }
      return done(bad("PARSE_FAILED", "VIVA could not open that PDF. Try another file, or paste the text.", 422));
    }
    input = { kind: "pdf", title: cleanTitle(form.get("title") || file.name, "Your PDF"), pages: parsed.pages };
  } else {
    let body: { kind?: string; title?: string; text?: string };
    try { body = (await req.json()) as typeof body; } catch { return done(bad("BAD_REQUEST", "Expected JSON.")); }
    const kind = body.kind === "named" ? "named" : "paste";
    const title = cleanTitle(body.title, kind === "named" ? "Your subject" : "Your notes");
    if (kind === "named") {
      if (!body.title || String(body.title).trim().length < 3) return done(bad("BAD_REQUEST", "Give the topic a name first."));
      input = { kind: "named", title };
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
