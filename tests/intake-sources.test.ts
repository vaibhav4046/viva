import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractReadable } from "@/lib/intake/html";
import { readDocx, readTextDoc, looksLikeZip } from "@/lib/intake/files";
import { fetchReadableUrl, isPrivateAddress } from "@/lib/intake/url";
import { buildSubject, type IntakeDoc } from "@/lib/intake/build";

/**
 * Loading a source from anywhere.
 *
 * The two things that can go badly wrong here are a fetch that reaches inside
 * the network it is running in, and a subject built out of a page VIVA could
 * not actually read. Both get a test.
 */

const PAGE = `<!doctype html><html><head><title>Photosynthesis — Study notes</title></head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <script>window.tracker = 1;</script>
  <main>
    <h1>Photosynthesis</h1>
    <p>Photosynthesis converts light energy into chemical energy stored in glucose, and it is the process almost every food chain on the planet ultimately depends on.</p>
    <h2>Light-dependent reactions</h2>
    <p>The light-dependent reactions happen in the thylakoid membrane, where water is split and oxygen is released as a by-product of that splitting.</p>
    <figure><figcaption>A diagram of a chloroplast that we cannot read.</figcaption></figure>
    <p>Short.</p>
    <p>The Calvin cycle runs in the stroma and fixes carbon dioxide using the ATP and NADPH produced by the light-dependent reactions before it.</p>
  </main>
  <footer><p>Copyright notice that is long enough to look like a paragraph of real prose but is not.</p></footer>
</body></html>`;

describe("readable extraction", () => {
  it("keeps the prose and the heading it sat under", () => {
    const readable = extractReadable(PAGE);
    expect(readable.title).toBe("Photosynthesis");
    const all = readable.sections.map((s) => s.text).join(" ");
    expect(all).toContain("thylakoid membrane");
    expect(all).toContain("Calvin cycle");
    expect(readable.sections.some((s) => s.heading === "Light-dependent reactions")).toBe(true);
  });

  it("drops navigation, scripts, captions and the footer", () => {
    const all = extractReadable(PAGE).sections.map((s) => s.text).join(" ");
    expect(all).not.toContain("window.tracker");
    expect(all).not.toContain("cannot read");
    expect(all).not.toContain("Copyright notice");
    expect(all).not.toContain("Short.");
  });

  it("decodes entities rather than showing them to the student", () => {
    const readable = extractReadable(
      "<p>Boyle&#x2019;s law says pressure &times; volume is constant &mdash; at a fixed temperature and amount of gas, which is what makes it useful.</p>"
    );
    expect(readable.sections[0].text).toContain("Boyle’s law");
    expect(readable.sections[0].text).toContain("×");
  });
});

describe("fetching a page is a trust boundary", () => {
  it("treats every private and reserved range as private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), `${ip} should be refused`).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "151.101.1.140", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  it("refuses loopback, private hosts and non-http schemes without fetching", async () => {
    for (const url of ["http://localhost:3000/admin", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]:8080/"]) {
      const res = await fetchReadableUrl(url);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("BLOCKED_HOST");
    }
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "not a url at all", ""]) {
      const res = await fetchReadableUrl(url);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("BAD_URL");
    }
  });

  it("re-checks the host after a redirect", async () => {
    // The classic bypass: a public address that 302s to the metadata service.
    // IP literals on both ends keep this test off DNS and off the network.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })) as typeof fetch;
    try {
      const res = await fetchReadableUrl("https://8.8.8.8/start");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("BLOCKED_HOST");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses a URL carrying credentials", async () => {
    const res = await fetchReadableUrl("https://user:secret@example.com/notes");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("BAD_URL");
  });
});

/** A one-entry zip, which is all a .docx is. */
function fakeDocx(documentXml: string, method: 8 | 0 = 8): Buffer {
  const name = Buffer.from("word/document.xml", "utf8");
  const raw = Buffer.from(documentXml, "utf8");
  const data = method === 8 ? deflateRawSync(raw) : raw;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
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

const DOCX_BODY = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>Week 3 notes</w:t></w:r></w:p>
<w:p><w:r><w:t>The nucleophile attacks the carbon at the same time as the leaving group departs, </w:t></w:r><w:r><w:t>which is what makes the SN2 mechanism a single concerted step.</w:t></w:r></w:p>
<w:p><w:r><w:t>Steric hindrance is what kills SN2: a tertiary carbon is surrounded by three alkyl groups and the backside approach is blocked, so the reaction cannot happen there.</w:t></w:r></w:p>
</w:body></w:document>`;

describe("plain files", () => {
  it("reads a Word document, headings and all", () => {
    const buf = fakeDocx(DOCX_BODY);
    expect(looksLikeZip(buf)).toBe(true);
    const read = readDocx(buf, "Week 3 notes");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.sections[0].heading).toBe("Week 3 notes");
    expect(read.doc.sections[0].text).toContain("concerted step");
    expect(read.doc.sections[0].text).toContain("Steric hindrance");
  });

  it("reads a stored (uncompressed) entry too", () => {
    const read = readDocx(fakeDocx(DOCX_BODY, 0), "Week 3");
    expect(read.ok).toBe(true);
  });

  it("refuses a zip with no Word document inside instead of inventing one", () => {
    const notWord = fakeDocx("<x/>").subarray(0);
    const patched = Buffer.from(notWord.toString("binary").replace(/word\/document\.xml/g, "other/document.xml"), "binary");
    const read = readDocx(patched, "Whatever");
    expect(read.ok).toBe(false);
  });

  it("turns markdown headings into sections a citation can name", () => {
    const md = [
      "# Cell structure",
      "",
      "All cells share four common components: a plasma membrane, cytoplasm, DNA and ribosomes, and that is true of every cell alive.",
      "",
      "## Prokaryotes",
      "",
      "A prokaryotic cell is a simple single-celled organism that lacks a nucleus or any other membrane-bound organelle inside it.",
    ].join("\n");
    const read = readTextDoc(md, "notes");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.sections.map((s) => s.heading)).toEqual(["Cell structure", "Prokaryotes"]);
  });

  it("says no rather than building a subject out of an empty file", () => {
    expect(readTextDoc("nothing here", "notes").ok).toBe(false);
  });
});

describe("several sources, one subject", () => {
  const lecture: IntakeDoc = {
    title: "Lecture 4 — cells",
    type: "text",
    pages: [
      {
        section: "Studying cells",
        text: "A cell is the smallest unit of a living thing, and every organism alive is made of one or more of them. Cell theory states that all living things are made of cells, that the cell is the basic unit of life, and that new cells arise from existing cells. Microscopes are what made all of this visible: magnification enlarges the image, and resolution is the ability to tell two adjacent points apart, which matters more than magnification does. A light microscope resolves about two hundred nanometres, an electron microscope far less than that, which is why organelles were invisible before electron microscopy existed.",
      },
    ],
  };
  const web: IntakeDoc = {
    title: "Prokaryotic cells — module site",
    type: "web",
    url: "https://example.edu/bio/prokaryotes",
    pages: [
      {
        section: "Prokaryotes",
        text: "A prokaryotic cell is a simple single-celled organism that lacks a nucleus and any other membrane-bound organelle. Prokaryotic DNA sits in the nucleoid, a central region of the cell that is not enclosed by a membrane. Most prokaryotes have a cell wall outside the plasma membrane, and in bacteria that wall is made of peptidoglycan. Many also carry flagella for movement and pili for attachment, and their small size gives them a high surface-area-to-volume ratio, which is what lets them exchange material with the environment fast enough to survive.",
      },
    ],
  };

  it("keeps each document as its own source, with its own provenance", async () => {
    const result = await buildSubject({ kind: "docs", title: "Cells", origin: "url", docs: [lecture, web] }, "u_test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const subject = result.subject;
    expect(subject.origin).toBe("url");
    expect(subject.sources.length).toBe(2);
    expect(subject.sources.map((s) => s.title)).toEqual([lecture.title, web.title]);
    expect(subject.sources[1].url).toBe("https://example.edu/bio/prokaryotes");
    // A citation resolves to the document the sentence is actually in.
    const bySource = new Map(subject.sources.map((s) => [s.id, s.chunks.map((c) => c.id)]));
    for (const source of subject.sources) {
      for (const chunk of source.chunks) {
        expect(chunk.sourceId).toBe(source.id);
        expect(bySource.get(source.id)).toContain(chunk.id);
        expect(chunk.locator.section).toBeTruthy();
      }
    }
    const ids = subject.sources.flatMap((s) => s.chunks.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a subject whose documents were all empty", async () => {
    const result = await buildSubject(
      { kind: "docs", title: "Nothing", origin: "url", docs: [{ title: "Blank", type: "web", pages: [{ text: "   " }] }] },
      "u_test"
    );
    expect(result.ok).toBe(false);
  });
});
