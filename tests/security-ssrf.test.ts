import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docFromUrl } from "@/lib/intake/sources";
import { fetchReadableUrl, isPrivateAddress } from "@/lib/intake/url";

/**
 * The host check in front of the fetcher, tested through the fetcher.
 *
 * The gap this file exists for: `new URL()` re-serialises
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and the old guard pattern-matched
 * the dotted spelling, so the address the code actually saw read as public and
 * loopback was fetched and stored. The suite had a test for it and the test
 * passed, because it called the predicate with the string a person types
 * rather than the string the parser emits.
 *
 * So every case here drives `fetchReadableUrl`, and the loopback cases point
 * at a real listener holding a real secret: if the guard fails, the assertion
 * fails with the secret in hand rather than on a technicality.
 */

const SECRET = "AKIA-INTERNAL-METADATA-9f3c1d2e";
const PAGE = `<!doctype html><html><head><title>Internal metadata service</title></head><body><main><h1>Internal metadata service</h1>
<p>This page is only reachable from inside the network and it is holding a credential that must never leave the host: ${SECRET}. It exists so that a server-side request forgery has something worth stealing, which is the only honest way to tell whether the host check in front of the fetcher works or only looks like it does.</p>
<p>The second paragraph is here so the readable-text extractor has more than four hundred characters of prose to keep, because the fetcher refuses anything shorter as unreadable and a refusal for the wrong reason would look exactly like the control working.</p>
</main></body></html>`;

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** What happened, in a shape that names the URL when it fails. */
async function attempt(url: string) {
  const res = await fetchReadableUrl(url);
  if (!res.ok) return { url, outcome: res.code, leaked: false };
  const text = res.readable.sections.map((s) => s.text).join(" ");
  return { url, outcome: "FETCHED", leaked: text.includes(SECRET) };
}

const refused = (url: string) => ({ url, outcome: "BLOCKED_HOST", leaked: false });

describe("SSRF: a live loopback listener behind every spelling of its address", () => {
  it("refuses IPv4-mapped IPv6 literals, which the URL parser rewrites to hex", async () => {
    for (const spelling of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:7f00:1]"]) {
      const url = `http://${spelling}:${port}/`;
      expect(await attempt(url)).toEqual(refused(url));
    }
  });

  it("refuses the dotted quad, the loopback range, and ::1", async () => {
    for (const spelling of ["127.0.0.1", "127.0.0.53", "[::1]", "[::127.0.0.1]"]) {
      const url = `http://${spelling}:${port}/`;
      expect(await attempt(url)).toEqual(refused(url));
    }
  });

  it("refuses decimal, octal, hex and short-form spellings of the same v4 address", async () => {
    for (const spelling of ["2130706433", "0177.0.0.1", "0x7f000001", "127.1"]) {
      const url = `http://${spelling}:${port}/`;
      expect(await attempt(url)).toEqual(refused(url));
    }
  });

  it("refuses 0.0.0.0, which routes to this host on every platform that accepts it", async () => {
    const url = `http://0.0.0.0:${port}/`;
    expect(await attempt(url)).toEqual(refused(url));
  });

  it("refuses it at docFromUrl too, which is the function the create route calls", async () => {
    // One layer up from the guard: POST /api/subjects/create {kind:"url"}
    // reaches this, and what it returns is what a stranger gets back.
    const res = await docFromUrl(`http://[::ffff:127.0.0.1]:${port}/`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ code: "BLOCKED_HOST", status: 400 });
  });
});

describe("SSRF: reserved ranges are refused before a socket is opened", () => {
  const RESERVED = [
    "169.254.169.254", // cloud metadata
    "[::ffff:169.254.169.254]",
    "[::ffff:a9fe:a9fe]", // the form the parser emits for the line above
    "[2002:a9fe:a9fe::]", // 6to4 carrying the metadata address
    "[64:ff9b::a9fe:a9fe]", // NAT64 carrying the metadata address
    "10.0.0.1",
    "[::ffff:10.0.0.1]",
    "[::ffff:a00:1]",
    "192.168.0.1",
    "[::ffff:c0a8:1]",
    "172.16.0.1",
    "100.64.0.1",
    "[fc00::1]", // unique local
    "[fd00::1]",
    "[fe80::1]", // link local
    "[ff02::1]", // multicast
    "[::]",
    "localhost",
  ];

  it("refuses each one without calling fetch", async () => {
    const original = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      reached.push(String(input));
      throw new Error("the guard let this through");
    }) as typeof fetch;
    try {
      for (const spelling of RESERVED) {
        const url = `http://${spelling}/`;
        const res = await fetchReadableUrl(url);
        expect({ url, ok: res.ok, code: res.ok ? null : res.code }).toEqual({ url, ok: false, code: "BLOCKED_HOST" });
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(reached).toEqual([]);
  });
});

describe("SSRF: the redirect chain is re-checked with the same rule", () => {
  it("refuses a public host that redirects to an IPv4-mapped loopback literal", async () => {
    const original = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      reached.push(String(input));
      return new Response(null, { status: 302, headers: { location: `http://[::ffff:127.0.0.1]:${port}/` } });
    }) as typeof fetch;
    try {
      const res = await fetchReadableUrl("https://8.8.8.8/start");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("BLOCKED_HOST");
    } finally {
      globalThis.fetch = original;
    }
    // The first hop was allowed; the hop it tried to hand off to was not.
    expect(reached).toEqual(["https://8.8.8.8/start"]);
  });
});

describe("SSRF: the predicate agrees with what the parser emits, not with what was typed", () => {
  it("classifies the emitted host, which is the only string the fetcher ever sees", () => {
    for (const typed of [
      "[::ffff:127.0.0.1]",
      "[::ffff:169.254.169.254]",
      "[0:0:0:0:0:ffff:7f00:1]",
      "[::127.0.0.1]",
      "2130706433",
      "0177.0.0.1",
      "0x7f000001",
    ]) {
      const emitted = new URL(`http://${typed}/`).hostname;
      expect(isPrivateAddress(emitted), `${typed} parses to ${emitted}`).toBe(true);
    }
  });
});
