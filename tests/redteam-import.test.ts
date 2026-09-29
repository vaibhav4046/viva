import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let did = "a".repeat(32);
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "viva_did" ? { value: did } : undefined) }),
}));

/**
 * The intake reader, unchanged, with one switch: when `fault.read` is set it
 * throws before reading, which is how these tests reach the route's catch.
 */
const fault = vi.hoisted(() => ({ read: null as null | (() => void) }));
vi.mock("@/lib/intake/sources", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/intake/sources")>();
  return {
    ...real,
    docFromFile: (...args: Parameters<typeof real.docFromFile>) => {
      fault.read?.();
      return real.docFromFile(...args);
    },
  };
});

import { POST } from "@/app/api/redteam/import/route";
import { POST as CREATE } from "@/app/api/redteam/session/route";
import { IMPORT_GIVE_UP_MS, IMPORT_MAX_BYTES, importFile, importLink } from "@/components/redteam/importApi";
import { PDF_MAX_BYTES } from "@/lib/intake/pdf";
import { __resetLimits } from "@/lib/limits";
import { __resetSessions } from "@/lib/redteam/store";
import { MAX_DOC_CHARS } from "@/lib/redteam/types";

/**
 * POST /api/redteam/import: a file or a link in, text to review out.
 *
 * The reading itself is the intake layer's and is tested there. What is held
 * here is what this route adds: what it will take, what it refuses and how it
 * says so, the cap that holds while a body is still arriving, the rate limit,
 * the Markdown the review builder reads, and that nothing internal is ever
 * said to the person who chose the file.
 */

const ENDPOINT = "http://localhost/api/redteam/import";
const savedFetch = globalThis.fetch;
const savedEnv = { hops: process.env.TRUSTED_PROXY_HOPS, vercel: process.env.VERCEL };

const bytesOf = (content: Buffer | string) => new Uint8Array(typeof content === "string" ? Buffer.from(content, "utf8") : content);

function upload(name: string, content: Buffer | string, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append("file", new File([bytesOf(content)], name));
  return new Request(ENDPOINT, { method: "POST", body: form, headers });
}

function link(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A body that yields `chunk` bytes per read and counts what was asked of it. */
function counted(chunk: number, stopAfter = 100 * 1024 * 1024) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += chunk;
        controller.enqueue(new Uint8Array(chunk));
        // A safety valve, so a route that never stops reading ends the test instead of hanging it.
        if (state.pulled >= stopAfter) controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { state, body };
}

const PARA_A = "The service keeps every evaluation in one primary Postgres instance, and read replicas exist only for reporting queries that can tolerate stale data.";
const PARA_B = "If the primary becomes unavailable, recovery is manual: an on-call operator promotes a replica, and the documented recovery target is thirty minutes.";
const PARA_C = "Failed provider calls are retried automatically up to three times with exponential backoff, and after the third failure the request fails with an explicit error.";

/** Nothing an operator would want and a stranger must not have. */
const INTERNAL = /node_modules|\/home\/|\/srv\/|\/tmp\/|\.next\b|\.tsx?:\d+|\bat\s+\S+\s+\(|\bat\s+(?:async\s+)?[\w$.<>]+\s+\(|stack|ENOENT/i;

async function readBody(res: Response) {
  const text = await res.text();
  return { text, json: JSON.parse(text) as any };
}

const restoreEnv = (key: "TRUSTED_PROXY_HOPS" | "VERCEL", value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  __resetLimits();
  __resetSessions();
  did = "a".repeat(32);
  fault.read = null;
  // Whoever runs this, the address is the one the route works out for itself.
  restoreEnv("TRUSTED_PROXY_HOPS", undefined);
  restoreEnv("VERCEL", undefined);
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  restoreEnv("TRUSTED_PROXY_HOPS", savedEnv.hops);
  restoreEnv("VERCEL", savedEnv.vercel);
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------- builders */

/** A one-entry zip, which is all a .docx is. Same shape the intake tests build. */
function zipOf(entry: string, xml: string): Buffer {
  const name = Buffer.from(entry, "utf8");
  const raw = Buffer.from(xml, "utf8");
  const data = deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);

  const localBlock = Buffer.concat([local, name, data]);
  const centralBlock = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

const wordXml = (paragraphs: string[]) =>
  `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

/** A valid PDF 1.4 with Helvetica text, one array of lines per page. ASCII only, so a string index is a byte offset. */
function tinyPdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/* ------------------------------------------------------------ what it takes */

describe("importing a file", () => {
  it("turns a text file into text a review can start from", async () => {
    const res = await POST(upload("storage-design.txt", [PARA_A, PARA_B, PARA_C].join("\n\n")));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { json: out } = await readBody(res);

    // Exactly the five fields, and nothing else the browser did not ask for.
    expect(Object.keys(out).sort()).toEqual(["chars", "sourceType", "text", "title", "truncated"]);
    expect(out).toMatchObject({ title: "storage-design", sourceType: "text", truncated: false });
    expect(out.chars).toBe(out.text.length);
    for (const p of [PARA_A, PARA_B, PARA_C]) expect(out.text).toContain(p);

    // The round trip: what came back is accepted as the document of a real review.
    const made = await CREATE(
      new Request("http://localhost/api/redteam/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "SKEPTIC", title: out.title, text: out.text }),
      })
    );
    expect(made.status).toBe(201);
    const { session } = await made.json();
    expect(session.document.title).toBe("storage-design");
    const passages: string[] = session.document.passages.map((p: { text: string }) => p.text);
    for (const p of [PARA_A, PARA_B, PARA_C]) expect(passages).toContain(p);
  });

  it("keeps a Markdown file's headings as the sections the review cites", async () => {
    const md = [
      "# Payments service design",
      "",
      "The payments service accepts card and bank transfers from the checkout page and writes every attempt to a ledger before it talks to a provider.",
      "",
      "## Failure handling",
      "",
      PARA_C,
      "",
      "### Data retention",
      "",
      "Ledger rows are kept for seven years to satisfy audit requirements and are never edited in place by any job.",
    ].join("\n");
    const res = await POST(upload("payments.md", md));
    expect(res.status).toBe(200);
    const { json: out } = await readBody(res);
    expect(out.sourceType).toBe("text");
    expect(out.title).toBe("payments");

    const at = (s: string) => out.text.indexOf(s);
    for (const h of ["## Payments service design", "## Failure handling", "## Data retention"]) expect(at(h), h).toBeGreaterThanOrEqual(0);
    expect(at("## Payments service design")).toBeLessThan(at("writes every attempt to a ledger"));
    expect(at("## Failure handling")).toBeLessThan(at(PARA_C));
    expect(at(PARA_C)).toBeLessThan(at("## Data retention"));
    expect(at("## Data retention")).toBeLessThan(at("Ledger rows are kept"));

    const made = await CREATE(
      new Request("http://localhost/api/redteam/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: out.title, text: out.text }),
      })
    );
    const { session } = await made.json();
    expect(session.document.sections.map((s: { heading: string }) => s.heading)).toEqual(["Payments service design", "Failure handling", "Data retention"]);
  });

  it("reads a Word document, headings and all", async () => {
    const docx = zipOf("word/document.xml", wordXml(["Storage", PARA_A, "Failure handling", PARA_B, PARA_C]));
    const res = await POST(upload("design-review.docx", docx));
    expect(res.status).toBe(200);
    const { json: out } = await readBody(res);
    expect(out).toMatchObject({ title: "design-review", sourceType: "doc", truncated: false });
    const at = (s: string) => out.text.indexOf(s);
    expect(at("## Storage")).toBeGreaterThanOrEqual(0);
    expect(at("## Storage")).toBeLessThan(at(PARA_A));
    expect(at(PARA_A)).toBeLessThan(at("## Failure handling"));
    expect(at("## Failure handling")).toBeLessThan(at(PARA_B));
    expect(out.text).toContain(PARA_C);
  });

  it("reads a PDF, one labelled section per page", async () => {
    // Short lines: text drawn past the page edge is not text the reader returns.
    const pdf = tinyPdf([
      [
        "Abstract",
        "This thesis studies how retrieval quality changes when the",
        "index is rebuilt nightly instead of on every write.",
        "Rebuilding nightly lowers cost, but it lets the index fall",
        "behind the documents by up to a day.",
      ],
      [
        "Results",
        "Recall at ten fell by four points on the freshest documents",
        "and stayed flat on everything older than a day.",
        "The cost of the nightly rebuild was about a fifth of the cost",
        "of updating on every write.",
      ],
    ]);
    const res = await POST(upload("thesis.pdf", pdf));
    expect(res.status).toBe(200);
    const { json: out } = await readBody(res);
    expect(out).toMatchObject({ title: "thesis", sourceType: "pdf", truncated: false });
    const at = (s: string) => out.text.indexOf(s);
    expect(at("## Page 1")).toBe(0);
    expect(at("## Page 1")).toBeLessThan(at("rebuilt nightly instead of on every write."));
    expect(at("rebuilt nightly instead of on every write.")).toBeLessThan(at("## Page 2"));
    expect(at("## Page 2")).toBeLessThan(at("Recall at ten fell"));
    expect(out.text).toContain("about a fifth of the cost of updating on every write.");
  });

  it("does not cut a word in half when a section runs on for thousands of characters", async () => {
    // The intake hands over a whole section as one line, and the review builder
    // cuts any line over 4,000 characters at a fixed offset.
    const sentences = Array.from({ length: 160 }, (_, i) => `Sentence number ${i + 1} keeps the retry budget bounded for the whole request.`);
    const md = `## Retries\n\n${sentences.join(" ")}`;
    const { json: out } = await readBody(await POST(upload("retries.md", md)));
    expect(out.truncated).toBe(false);
    for (const line of out.text.split("\n")) expect(line.length).toBeLessThan(3_100);
    for (const s of sentences) expect(out.text, s).toContain(s);
  });

  it("gives an unsigned browser a cookie, and every answer carries it", async () => {
    did = "not-an-id";
    for (const req of [upload("notes.txt", `${PARA_A} ${PARA_B}`), upload("blank.txt", "   ")]) {
      const res = await POST(req);
      expect(res.headers.get("set-cookie")).toMatch(/^viva_did=[0-9a-f]{32}; /);
      expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    }
  });
});

/* ------------------------------------------------------------ what it refuses */

describe("what it refuses", () => {
  it("refuses a body that declares more than the ceiling without reading any of it", async () => {
    // One byte over, as /api/subjects/create is tested, and far over.
    for (const declared of [PDF_MAX_BYTES + 1, PDF_MAX_BYTES + 10 * 1024 * 1024]) {
      __resetLimits();
      const { state, body } = counted(1);
      const req = new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(declared) },
        body,
        duplex: "half",
      } as RequestInit);
      const res = await POST(req);
      expect(res.status, String(declared)).toBe(413);
      const { json } = await readBody(res);
      expect(json.error.code).toBe("FILE_TOO_LARGE");
      // The number in the sentence comes from the constant, not from a second copy of it.
      expect(json.error.message).toContain(`${Math.round(PDF_MAX_BYTES / (1024 * 1024))} MB`);
      expect(state.pulled, String(declared)).toBe(0);
    }
  });

  it("stops reading a body that never declared its length once it passes the ceiling", async () => {
    const { state, body } = counted(64 * 1024);
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("FILE_TOO_LARGE");
    // 100 MB was on offer. The read ended within a chunk of the ceiling.
    expect(state.pulled).toBeGreaterThan(PDF_MAX_BYTES);
    expect(state.pulled).toBeLessThan(PDF_MAX_BYTES + 128 * 1024);
  });

  it("refuses a real upload over the ceiling that declared nothing", async () => {
    const res = await POST(upload("thesis.pdf", Buffer.alloc(PDF_MAX_BYTES + 1, 0x61)));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("FILE_TOO_LARGE");
  });

  it("leaves a plain text file's own, smaller ceiling to the intake", async () => {
    // Under the request ceiling, so it is read; over the intake's 2 MB for text, so the intake says no.
    const res = await POST(upload("huge.txt", "word ".repeat(700_000)));
    expect(res.status).toBe(413);
    const { json } = await readBody(res);
    expect(json.error.code).toBe("FILE_TOO_LARGE");
    expect(json.error.message).toContain("2 MB");
  });

  it("refuses a link body that is not a short string", async () => {
    const res = await POST(link({ url: `https://8.8.8.8/${"a".repeat(9_000)}` }));
    expect(res.status).toBe(413);
  });

  it("says plainly that it cannot read a type it does not take", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 7)]);
    const junk = Buffer.from(Array.from({ length: 2_000 }, (_, i) => (i * 37 + 11) % 256));
    const cases: [string, Buffer | string, string][] = [
      ["diagram.png", png, "UNSUPPORTED_TYPE"], // by its name
      ["export.csv", "a,b,c\n1,2,3\n", "UNSUPPORTED_TYPE"], // readable, but not a format it takes
      ["slides.pptx", zipOf("ppt/presentation.xml", "<p/>"), "UNSUPPORTED_TYPE"],
      ["notes.txt", junk, "BAD_FILE"], // called text, is not: the intake looks at the bytes
      ["renamed.docx", zipOf("other/thing.xml", "<x/>"), "BAD_FILE"], // a zip with no Word document in it
    ];
    for (const [name, content, code] of cases) {
      const res = await POST(upload(name, content));
      expect(res.status, name).toBe(415);
      const { text, json } = await readBody(res);
      expect(json.error.code, name).toBe(code);
      expect(json.error.message.length, name).toBeGreaterThan(20);
      expect(json.error.message.length, name).toBeLessThan(220);
      expect(text, name).not.toMatch(INTERNAL);
    }
  });

  it("refuses a file with nothing in it: empty, only whitespace, only control characters, or a blank Word file", async () => {
    const cases: [string, Buffer | string][] = [
      ["empty.txt", ""],
      ["blank.txt", " \n\t\n  ".repeat(200)],
      ["blank.md", "\n\n\n   \n"],
      ["nul.txt", Buffer.alloc(3_000, 0)],
      ["blank.docx", zipOf("word/document.xml", wordXml(["   ", " ", " "]))],
    ];
    for (const [name, content] of cases) {
      const res = await POST(upload(name, content));
      expect(res.status, name).toBe(422);
      const { json } = await readBody(res);
      expect(json.error.code, name).toBe("NO_TEXT_IN_FILE");
    }
  });

  it("refuses a request that is not one file", async () => {
    const none = await POST(new Request(ENDPOINT, { method: "POST", body: new FormData() }));
    expect(none.status).toBe(400);
    expect((await none.json()).error.code).toBe("NO_FILE");

    const text = new FormData();
    text.append("file", "just a string, not a file");
    const string = await POST(new Request(ENDPOINT, { method: "POST", body: text }));
    expect(string.status).toBe(400);
    expect((await string.json()).error.code).toBe("NO_FILE");

    const two = new FormData();
    two.append("file", new File([bytesOf(PARA_A)], "a.txt"));
    two.append("file", new File([bytesOf(PARA_B)], "b.txt"));
    const both = await POST(new Request(ENDPOINT, { method: "POST", body: two }));
    expect(both.status).toBe(400);

    // Neither multipart nor JSON.
    const plain = await POST(new Request(ENDPOINT, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }));
    expect(plain.status).toBe(400);
  });
});

/* -------------------------------------------------------------------- links */

describe("importing a link", () => {
  const PAGE = `<!doctype html><html><head><title>Payments retries</title></head><body><main>
<h1>Payments retries</h1>
<p>${PARA_C} It also records every attempt in the ledger before it talks to the provider, so a retried write cannot be applied twice.</p>
<h2>Recovery</h2>
<p>${PARA_B} The operator records the promotion in the incident log, and the old primary is rebuilt as a replica once it returns.</p>
</main></body></html>`;

  const networkAsked = () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      throw new Error("no network in this test");
    }) as typeof fetch;
    return seen;
  };

  it("refuses loopback, metadata, private and non-web addresses before it fetches anything", async () => {
    const seen = networkAsked();
    const cases: [string, string][] = [
      ["http://127.0.0.1/", "BLOCKED_HOST"],
      ["http://169.254.169.254/latest/meta-data/", "BLOCKED_HOST"],
      ["http://localhost:3000/admin", "BLOCKED_HOST"],
      ["http://[::1]:8080/", "BLOCKED_HOST"],
      ["http://[::ffff:127.0.0.1]/", "BLOCKED_HOST"],
      ["file:///etc/passwd", "BAD_URL"],
    ];
    for (const [url, code] of cases) {
      const res = await POST(link({ url }));
      expect(res.status, url).toBe(400);
      const { text, json } = await readBody(res);
      expect(json.error.code, url).toBe(code);
      expect(text, url).not.toMatch(INTERNAL);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a public address that redirects inside the network", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as typeof fetch;
    const res = await POST(link({ url: "https://8.8.8.8/start" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BLOCKED_HOST");
    expect(seen).toEqual(["https://8.8.8.8/start"]);
  });

  it("refuses JSON that carries anything but a url, and never fetches", async () => {
    const seen = networkAsked();
    const bodies: unknown[] = [
      { url: "https://8.8.8.8/x", admin: true },
      { url: "https://8.8.8.8/x", urls: ["http://127.0.0.1/"] },
      { url: "https://8.8.8.8/x", __proto__: { polluted: true }, constructor: 1 },
      {},
      { url: 5 },
      { url: null },
      { url: "   " },
      ["https://8.8.8.8/x"],
      "{not json",
      "",
    ];
    for (const body of bodies) {
      __resetLimits();
      const res = await POST(link(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code, JSON.stringify(body)).toBe("BAD_REQUEST");
    }
    expect(seen).toEqual([]);
  });

  it("reads a public page into headed sections and names it by its own title", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;

    const res = await POST(link({ url: "https://8.8.8.8/design-note" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { json: out } = await readBody(res);
    expect(out).toMatchObject({ title: "Payments retries", sourceType: "web", truncated: false });
    expect(out.chars).toBe(out.text.length);
    const at = (s: string) => out.text.indexOf(s);
    expect(at("## Payments retries")).toBe(0);
    expect(at("## Payments retries")).toBeLessThan(at(PARA_C));
    expect(at(PARA_C)).toBeLessThan(at("## Recovery"));
    expect(at("## Recovery")).toBeLessThan(at(PARA_B));

    // One request, to the address given, and redirects are followed by hand, not by fetch.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://8.8.8.8/design-note");
    expect(seen[0].init?.redirect).toBe("manual");
  });

  it("points a link to a PDF at the file option, in the intake's own words", async () => {
    globalThis.fetch = (async () => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch;
    const res = await POST(link({ url: "https://8.8.8.8/thesis.pdf" }));
    expect(res.status).toBe(422);
    const { json } = await readBody(res);
    expect(json.error.code).toBe("UNSUPPORTED_TYPE");
    expect(json.error.message).toMatch(/upload the file/i);
  });
});

/* --------------------------------------------------------------------- caps */

describe("the document limit", () => {
  const section = (n: number) => `Section ${n} says the queue has one consumer, and that consumer acknowledges each message only after the ledger write has been committed. ${"Padding sentence for length. ".repeat(20)}`.trim();
  const doc = (count: number) => Array.from({ length: count }, (_, i) => `## Section ${i + 1}\n\n${section(i + 1)}`).join("\n\n");

  it("cuts a document that is too long at a paragraph, and says it was cut", async () => {
    const res = await POST(upload("long.md", doc(120)));
    expect(res.status).toBe(200);
    const { json: out } = await readBody(res);
    expect(out.truncated).toBe(true);
    expect(out.chars).toBe(out.text.length);
    expect(out.chars).toBeLessThanOrEqual(MAX_DOC_CHARS);
    // Close to the cap, not cut early.
    expect(out.chars).toBeGreaterThan(MAX_DOC_CHARS - 1_500);

    // It ends on a whole paragraph, never on a heading with nothing under it or in the middle of a sentence.
    const kept = (out.text.match(/^## Section \d+$/gm) ?? []).length;
    expect(kept).toBeGreaterThan(50);
    expect(kept).toBeLessThan(120);
    expect(out.text.endsWith(section(kept))).toBe(true);
    expect(out.text).not.toMatch(/\n## Section \d+\s*$/);
    // The whole beginning is kept, in order.
    expect(out.text.startsWith(`## Section 1\n\n${section(1)}\n\n## Section 2`)).toBe(true);

    // And what came back is short enough for the review to accept as it is.
    const made = await CREATE(
      new Request("http://localhost/api/redteam/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: out.title, text: out.text }),
      })
    );
    expect(made.status).toBe(201);
  });

  it("does not say it cut anything when nothing was cut", async () => {
    const { json: out } = await readBody(await POST(upload("short.md", doc(40))));
    expect(out.truncated).toBe(false);
    expect(out.chars).toBeLessThan(MAX_DOC_CHARS);
    expect((out.text.match(/^## Section \d+$/gm) ?? []).length).toBe(40);
  });
});

/* -------------------------------------------------------------- rate limit */

describe("the rate limit", () => {
  const nothing = (headers: Record<string, string> = {}) => link({ url: "not a web address" }, headers);

  it("counts a caller by address, whatever cookie or x-forwarded-for they write", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      did = i.toString(16).padStart(32, "0"); // a new browser every time
      statuses.push((await POST(nothing({ "x-forwarded-for": `9.9.9.${i}` }))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("counts a caller by browser too, even from a fresh address each time", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1"; // the address now comes from x-forwarded-for
    for (let i = 0; i < 10; i++) expect((await POST(nothing({ "x-forwarded-for": `9.9.8.${i}` }))).status).toBe(400);

    const limited = await POST(nothing({ "x-forwarded-for": "9.9.8.99" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    const { json } = await readBody(limited);
    expect(json.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });

    // Somebody else, from somewhere else, is not held back by it.
    did = "b".repeat(32);
    expect((await POST(nothing({ "x-forwarded-for": "9.9.8.100" }))).status).toBe(400);
  });

  it("answers before it reads a body, so a limited caller costs nothing", async () => {
    for (let i = 0; i < 10; i++) await POST(nothing());
    const { state, body } = counted(1024);
    const res = await POST(
      new Request(ENDPOINT, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half" } as RequestInit)
    );
    expect(res.status).toBe(429);
    expect(state.pulled).toBe(0);
  });

  it("has its own budget, apart from the one for starting a review", async () => {
    for (let i = 0; i < 10; i++) await POST(nothing());
    expect((await POST(nothing())).status).toBe(429);
    const made = await CREATE(
      new Request("http://localhost/api/redteam/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sample: true }) })
    );
    expect(made.status).toBe(201);
  });
});

/* ------------------------------------------------------ nothing internal */

describe("what a person is told", () => {
  it("never includes a stack trace or a path, in a success or in any refusal", async () => {
    networkOnly();
    const requests: Request[] = [
      upload("ok.txt", `${PARA_A} ${PARA_B}`),
      upload("photo.png", Buffer.alloc(400, 9)),
      upload("junk.txt", Buffer.from(Array.from({ length: 2_000 }, (_, i) => (i * 37 + 11) % 256))),
      upload("broken.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 0x20)])),
      upload("broken.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300, 1)])),
      link({ url: "http://169.254.169.254/" }),
      link({ url: "http://127.0.0.1:9/" }),
      link({ nope: 1 }),
    ];
    for (const req of requests) {
      const res = await POST(req);
      const text = await res.text();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toMatch(INTERNAL);
      if (res.status >= 400) {
        const { error } = JSON.parse(text);
        expect(Object.keys(error).sort()).toEqual(["code", "message", "retryable"]);
      }
    }
  });

  it("answers an unexpected failure with one plain sentence, and keeps the detail to itself", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fault.read = () => {
      throw new Error("ENOENT: open '/srv/app/.next/server/chunks/reader.js'\n    at Object.readFileSync (node:fs:441:20)");
    };
    const res = await POST(upload("notes.txt", `${PARA_A} ${PARA_B}`));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { text, json } = await readBody(res);
    expect(json.error).toMatchObject({ code: "IMPORT_FAILED", retryable: true });
    expect(json.error.message).toMatch(/could not be read/i);
    expect(text).not.toMatch(INTERNAL);
    expect(text).not.toMatch(/readFileSync|reader\.js/);
    // The operator still has it.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe("redteam.import.failed");
  });

  it("only takes a POST, so anything else gets the framework's own refusal", async () => {
    const mod = (await import("@/app/api/redteam/import/route")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /^(GET|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});

/** A fetch that fails loudly, for tests where no page should be asked for. */
function networkOnly() {
  globalThis.fetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;
}

/* ---------------------------------------------------------------- the page */

describe("the browser's side of it", () => {
  const ok = { title: "Thesis", text: "## Page 1\n\nSomething.", chars: 20, truncated: false, sourceType: "pdf" };
  const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" } });

  it("asks for the same ceiling the server enforces", () => {
    expect(IMPORT_MAX_BYTES).toBe(PDF_MAX_BYTES);
  });

  it("sends a file as multipart, leaving the boundary to the browser, and a link as JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return reply(200, ok);
    }) as typeof fetch;

    const file = await importFile(new File([bytesOf(PARA_A)], "thesis.pdf"));
    expect(file).toEqual(ok);
    await importLink("https://8.8.8.8/x");

    expect(calls.map((c) => c.url)).toEqual(["/api/redteam/import", "/api/redteam/import"]);
    expect(calls.every((c) => c.init.method === "POST" && c.init.cache === "no-store")).toBe(true);
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect(((calls[0].init.body as FormData).get("file") as File).name).toBe("thesis.pdf");
    expect(new Headers(calls[0].init.headers).has("content-type")).toBe(false);
    expect(new Headers(calls[1].init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ url: "https://8.8.8.8/x" });
  });

  it("turns every way it can fail into a sentence", async () => {
    globalThis.fetch = (async () => reply(415, { error: { code: "BAD_FILE", message: "That file is something else.", retryable: false } })) as typeof fetch;
    await expect(importFile(new File([bytesOf("x")], "a.txt"))).rejects.toThrow("That file is something else.");

    // The platform's own page for an oversize body is not JSON.
    globalThis.fetch = (async () => reply(413, "Request Entity Too Large")) as typeof fetch;
    await expect(importFile(new File([bytesOf("x")], "a.txt"))).rejects.toThrow(/over 4 MB/);

    globalThis.fetch = (async () => reply(502, "<html>Bad gateway</html>")) as typeof fetch;
    await expect(importLink("https://8.8.8.8/x")).rejects.toThrow("That did not go through. Try again.");

    globalThis.fetch = (async () => reply(200, { nope: true })) as typeof fetch;
    await expect(importLink("https://8.8.8.8/x")).rejects.toThrow("That did not go through. Try again.");

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(importLink("https://8.8.8.8/x")).rejects.toThrow(/could not reach the server/i);
  });

  it("lets a cancelled call stay cancelled instead of reporting it as a failure", async () => {
    // A fetch that ends the way the real one does when its signal is aborted.
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return reply(200, ok);
    }) as typeof fetch;
    const page = new AbortController();
    page.abort();
    await expect(importLink("https://8.8.8.8/x", page.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(importFile(new File([bytesOf("x")], "a.txt"), page.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops waiting after a while, with a sentence, and lets the page cancel sooner", async () => {
    vi.useFakeTimers();
    try {
      // A server that never answers, and a fetch that ends when it is told to.
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        })) as typeof fetch;

      const slow = expect(importLink("https://8.8.8.8/x")).rejects.toThrow(/taking too long/i);
      await vi.advanceTimersByTimeAsync(IMPORT_GIVE_UP_MS);
      await slow;

      const page = new AbortController();
      const cancelled = expect(importFile(new File([bytesOf("x")], "a.txt"), page.signal)).rejects.toMatchObject({ name: "AbortError" });
      page.abort();
      await cancelled;
    } finally {
      vi.useRealTimers();
    }
  });
});
