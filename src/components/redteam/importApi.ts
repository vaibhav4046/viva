/**
 * The browser's side of POST /api/redteam/import.
 *
 * It sits beside api.ts rather than in it: this call sends a file as well as
 * JSON, and what goes wrong with it is about the file ("that is too big"), not
 * about a review. Every call goes to our own origin, and nothing here keeps
 * what it reads. The text comes back for the person to read and edit first.
 */

export type ImportedDocument = {
  title: string;
  text: string;
  /** The length of `text`, which is what counts against the document limit. */
  chars: number;
  /** True when the source ran past the limit and its end was left off. */
  truncated: boolean;
  /** The intake's own label: "pdf", "doc", "text" or "web". */
  sourceType: string;
};

/**
 * The largest file the server takes: the same number as PDF_MAX_BYTES in
 * src/lib/intake/pdf.ts. That module cannot be imported here, because it
 * carries the PDF reader, so a test holds the two together. The server is the
 * authority; this only spares an upload it would refuse.
 */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export const IMPORT_MAX_MB = Math.round(IMPORT_MAX_BYTES / (1024 * 1024));

export const IMPORT_TOO_BIG = `That file is over ${IMPORT_MAX_MB} MB. Try a smaller one, or paste the part you need to defend.`;

/**
 * The server stops reading a page or a PDF inside a minute. The browser stops
 * waiting a little after that, so a dropped connection cannot leave the boxes
 * locked for as long as the network cares to take.
 */
export const IMPORT_GIVE_UP_MS = 75_000;

const ENDPOINT = "/api/redteam/import";
const NOT_SENT = "That did not go through. Try again.";
const OFFLINE = "VIVA could not reach the server. Check your connection and try again.";
const TOO_SLOW = "That is taking too long. Try again, or paste the text.";

type Reply = Partial<ImportedDocument> & { error?: { message?: string } };

async function send(init: { body: BodyInit; headers?: Record<string, string> }, signal?: AbortSignal): Promise<ImportedDocument> {
  // One signal for the fetch: the page's own, and the clock.
  const call = new AbortController();
  const cancel = () => call.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const clock = setTimeout(cancel, IMPORT_GIVE_UP_MS);
  try {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, { method: "POST", ...init, cache: "no-store", signal: call.signal });
    } catch (e) {
      // A call the page cancelled is not a failure to report.
      if (signal?.aborted) throw e;
      throw new Error(call.signal.aborted ? TOO_SLOW : OFFLINE);
    }
    // The platform answers an oversize body with a plain page of its own, so a
    // body that is not JSON still has to end in a sentence.
    const json = (await res.json().catch(() => null)) as Reply | null;
    if (signal?.aborted) throw new DOMException("The import was cancelled.", "AbortError");
    if (call.signal.aborted) throw new Error(TOO_SLOW);
    if (!res.ok) throw new Error(json?.error?.message || (res.status === 413 ? IMPORT_TOO_BIG : NOT_SENT));
    if (!json || typeof json.title !== "string" || typeof json.text !== "string") throw new Error(NOT_SENT);
    return {
      title: json.title,
      text: json.text,
      chars: typeof json.chars === "number" ? json.chars : json.text.length,
      truncated: json.truncated === true,
      sourceType: typeof json.sourceType === "string" ? json.sourceType : "",
    };
  } finally {
    clearTimeout(clock);
    signal?.removeEventListener("abort", cancel);
  }
}

/** A PDF, Word, text or Markdown file. The browser writes the multipart headers itself. */
export function importFile(file: File, signal?: AbortSignal): Promise<ImportedDocument> {
  const form = new FormData();
  form.append("file", file, file.name);
  return send({ body: form }, signal);
}

/** A page on the public web. The server fetches it; the browser never does. */
export function importLink(url: string, signal?: AbortSignal): Promise<ImportedDocument> {
  return send({ body: JSON.stringify({ url }), headers: { "Content-Type": "application/json" } }, signal);
}
