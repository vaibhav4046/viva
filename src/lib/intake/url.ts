import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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

/**
 * Everything that is not a public unicast address, held as ranges rather than
 * as spellings.
 *
 * The version this replaces matched on the text a person types, and the parser
 * does not hand it that text. `new URL()` re-serialises `[::ffff:127.0.0.1]`
 * to `[::ffff:7f00:1]`, which the old mapped-address regex could never match,
 * and `bare.split(":")[0]` is the empty string for any address written with a
 * leading `::`, so the unique-local, link-local and multicast tests underneath
 * it were all comparing "". Loopback and 169.254.169.254 both read as public
 * and were fetched, and the body came back to the student as subject text.
 *
 * BlockList decides on the parsed bytes and folds an IPv4-mapped v6 address
 * onto the v4 rules itself, so every spelling of one address — dotted,
 * decimal, octal, hex, mapped, IPv4-compatible, 6to4, NAT64 — gets the same
 * answer. That is the difference between a guard and a filter: a filter can
 * always be beaten by writing the address a different way.
 */
const RESERVED = new BlockList();
for (const [range, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 16], // protocol assignments and TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.0.0", 16], // TEST-NET-2
  ["203.0.0.0", 16], // TEST-NET-3
  ["224.0.0.0", 3], // multicast and reserved
] as const) {
  RESERVED.addSubnet(range, prefix, "ipv4");
}
for (const [range, prefix] of [
  ["::", 96], // unspecified, loopback, and IPv4-compatible (::127.0.0.1)
  // The next four are v6 shapes that carry a v4 destination inside them.
  ["::ffff:0:0:0", 96], // IPv4-translated
  ["64:ff9b::", 96], // NAT64, well-known prefix
  ["64:ff9b:1::", 48], // NAT64, local-use prefixes
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["fec0::", 10], // site local: deprecated, still routed inside networks
  ["ff00::", 8], // multicast
] as const) {
  RESERVED.addSubnet(range, prefix, "ipv6");
}

/** Anything that is not a public unicast address a student could have meant. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const kind = isIP(bare);
  // Not an address at all, so there is nothing here that can vouch for it.
  if (kind === 0) return true;
  return RESERVED.check(bare, kind === 6 ? "ipv6" : "ipv4");
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
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return !isPrivateAddress(bare);
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
