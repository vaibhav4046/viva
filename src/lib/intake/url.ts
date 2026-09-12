import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractReadable, type Readable } from "./html";

/**
 * A web page a student points VIVA at.
 *
 * This is the one place where the server fetches an address a stranger chose,
 * so it is a trust boundary and treated like one: http(s) only, no credentials
 * in the URL, every hop's host resolved and refused if it points inside the
 * network, a byte cap, a time cap, and a content type this app can actually
 * read. What comes back is the page's own prose, kept with the page's own URL
 * and title so a citation still names where the sentence came from — never
 * relabelled as something the student wrote.
 */

export const URL_MAX_BYTES = 3 * 1024 * 1024;
export const URL_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MIN_READABLE_CHARS = 400;

export type UrlFetchError =
  | "BAD_URL"
  | "BLOCKED_HOST"
  | "UNREACHABLE"
  | "HTTP_ERROR"
  | "UNSUPPORTED_TYPE"
  | "TOO_LARGE"
  | "NO_READABLE_TEXT";

export type UrlFetchResult =
  | { ok: true; url: string; title: string; readable: Readable }
  | { ok: false; code: UrlFetchError; message: string };

const MESSAGES: Record<UrlFetchError, string> = {
  BAD_URL: "That does not look like a web address. Paste the full link, starting with https://.",
  BLOCKED_HOST: "VIVA will only read pages on the public web, and that address is not one.",
  UNREACHABLE: "VIVA could not reach that page. Check the link, or paste the text instead.",
  HTTP_ERROR: "That page would not open — it may need a sign-in, or it may be gone. Paste the text instead.",
  UNSUPPORTED_TYPE: "That link is not a web page VIVA can read. Upload the file, or paste the text.",
  TOO_LARGE: "That page is too big to read in one go. Try a single article, or paste the part you are studying.",
  NO_READABLE_TEXT:
    "There was not enough readable text on that page — it may be mostly video, images or a sign-in wall. VIVA will not guess at what it said. Paste the text and it will read that.",
};

function fail(code: UrlFetchError): UrlFetchResult {
  return { ok: false, code, message: MESSAGES[code] };
}

/** Anything that is not a public unicast address a student could have meant. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip.toLowerCase());
  return true;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (bare === "::" || bare === "::1") return true;
  // IPv4-mapped (::ffff:10.0.0.1) resolves to the v4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return isPrivateV4(mapped[1]);
  const head = bare.split(":")[0];
  if (/^f[cd]/.test(head)) return true; // unique local
  if (/^fe[89ab]/.test(head)) return true; // link-local
  if (/^ff/.test(head)) return true; // multicast
  return false;
}

/**
 * Every address this host resolves to has to be public.
 *
 * ponytail: this is a check-then-connect, so a name that answers publicly here
 * and privately a millisecond later (DNS rebinding) is not covered. Closing
 * that means pinning the resolved IP into the connection, which needs a custom
 * agent; the cap on redirects, methods and response size keeps the blast
 * radius of that window to a single GET of a page we then only read as text.
 */
async function hostIsPublic(hostname: string): Promise<boolean> {
  const literal = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (literal) return !isPrivateAddress(hostname.replace(/^\[|\]$/g, ""));
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.home$/i.test(hostname)) return false;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
}

function parseTarget(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  // "example.com/notes" is a web address a person typed. "file:///etc/passwd"
  // is not, and gluing https:// onto it would turn it into a host named
  // "file" — a refusal for the wrong reason, from code that already knew.
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Credentials in a URL are either a mistake or an attempt to reach something
  // that is not ours to read. Either way VIVA does not send them.
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url;
}

/** Read the body with a hard byte cap, so a stream that never ends still does. */
async function readCapped(res: Response): Promise<string | "too_large"> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > URL_MAX_BYTES) return "too_large";
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > URL_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(parts));
}

const READABLE_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/xml|text\/xml)/i;

export async function fetchReadableUrl(raw: string): Promise<UrlFetchResult> {
  let target = parseTarget(raw);
  if (!target) return fail("BAD_URL");

  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(await hostIsPublic(target.hostname))) return fail("BLOCKED_HOST");
    try {
      res = await fetch(target.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          // Say who is asking. Some sites serve a different page to a blank UA.
          "User-Agent": "VIVA-study-bot/1.0 (+https://viva-five-murex.vercel.app)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return fail("UNREACHABLE");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return fail("HTTP_ERROR");
      const next = parseTarget(new URL(location, target).toString());
      if (!next) return fail("BLOCKED_HOST");
      target = next;
      res = null;
      continue;
    }
    break;
  }
  if (!res) return fail("HTTP_ERROR");
  if (!res.ok) return fail("HTTP_ERROR");

  const type = res.headers.get("content-type") ?? "text/html";
  if (!READABLE_TYPES.test(type)) return fail("UNSUPPORTED_TYPE");

  const body = await readCapped(res);
  if (body === "too_large") return fail("TOO_LARGE");

  const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
  const readable = isHtml
    ? extractReadable(body)
    : { title: null, sections: [{ text: body.replace(/\s+/g, " ").trim() }], chars: body.trim().length };

  if (readable.chars < MIN_READABLE_CHARS) return fail("NO_READABLE_TEXT");

  return {
    ok: true,
    url: target.toString(),
    title: readable.title ?? target.hostname + target.pathname.replace(/\/$/, ""),
    readable,
  };
}
