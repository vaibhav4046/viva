import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readDocx, TEXT_MAX_BYTES } from "@/lib/intake/files";
import { parseKeytermHint, subjectVoiceConfig } from "@/app/api/voice/transcribe/route";
import { LANGUAGE_PRESETS } from "@/components/voice/MicButton";
import { toStreamLanguage, AUTO_LANGUAGE } from "@/lib/audio/stream";

/**
 * Build a real single-entry zip around `payload`, the way a .docx is shaped.
 * Hand-rolled because the reader is hand-rolled: a fixture built by a library
 * would not prove the reader survives what an attacker actually sends.
 */
function docx(name: string, payload: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "ascii");
  const body = deflateRawSync(payload);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);              // deflate
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);           // local header offset

  const localPart = Buffer.concat([local, nameBuf, body]);
  const centralPart = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, end]);
}

describe("readDocx bounds what it inflates", () => {
  it("reads an ordinary document", () => {
    // Long enough to clear the reader's own "there is no real text in this"
    // floor, which a two-sentence fixture does not.
    const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const xml =
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      para("Michaelis-Menten kinetics") +
      para(
        "The Michaelis constant KM is the substrate concentration at which the reaction rate is half of Vmax. " +
          "It is a property of the enzyme and the substrate together, not of how much enzyme is present, " +
          "which is why doubling the enzyme doubles Vmax and leaves KM where it was."
      ) +
      para(
        "A competitive inhibitor raises the apparent KM without changing Vmax, because enough substrate " +
          "still outcompetes it. A non-competitive inhibitor lowers Vmax and leaves KM alone."
      ) +
      "</w:body></w:document>";
    const out = readDocx(docx("word/document.xml", Buffer.from(xml)), "notes");
    expect(out.ok).toBe(true);
    const sections = out.ok ? out.doc.sections : [];
    // The short opening paragraph becomes the section heading, which is the
    // behaviour that makes a Word document's own structure into locators.
    expect(sections.map((x) => x.heading)).toContain("Michaelis-Menten kinetics");
    expect(sections.map((x) => x.text).join(" ")).toContain("half of Vmax");
  });

  it("refuses a decompression bomb instead of inflating it", () => {
    // Highly compressible: measured 258:1 on a real crafted .docx, which put a
    // 4 MB upload at about a gigabyte and OOM-killed the function.
    const payload = Buffer.alloc(TEXT_MAX_BYTES * 4, 0x41);
    const bomb = docx("word/document.xml", payload);
    expect(bomb.length).toBeLessThan(TEXT_MAX_BYTES);

    const before = process.memoryUsage().heapUsed;
    const out = readDocx(bomb, "bomb");
    const grew = process.memoryUsage().heapUsed - before;

    // Refused, not inflated. The whole point is that it never materialised;
    // allow slack for the test's own buffers, but a gigabyte blows past this.
    expect(out.ok).toBe(false);
    expect(grew).toBeLessThan(TEXT_MAX_BYTES * 6);
  });

  it("refuses an oversized STORED entry too, which skips inflate entirely", () => {
    const payload = Buffer.alloc(TEXT_MAX_BYTES + 1024, 0x41);
    const nameBuf = Buffer.from("word/document.xml", "ascii");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);
    const localPart = Buffer.concat([local, nameBuf, payload]);
    const centralPart = Buffer.concat([central, nameBuf]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralPart.length, 12);
    end.writeUInt32LE(localPart.length, 16);

    expect(readDocx(Buffer.concat([localPart, centralPart, end]), "stored").ok).toBe(false);
  });
});

describe("the browser's key-term hint", () => {
  it("reads a JSON array of strings", () => {
    expect(parseKeytermHint('["positional encoding","softmax"]')).toEqual(["positional encoding", "softmax"]);
  });

  it("treats anything malformed as no hint at all", () => {
    for (const bad of [null, "", "not json", "{}", '"a string"', "[1,2,3]"]) {
      expect(parseKeytermHint(bad as string | null)).toEqual([]);
    }
    expect(parseKeytermHint('[1,"kept",null]')).toEqual(["kept"]);
  });

  it("fills in when the subject cannot be resolved on this instance", async () => {
    const out = await subjectVoiceConfig("nobody", "subject_that_does_not_exist", [
      "Michaelis-Menten",
      "michaelis-menten",
      "  Vmax  ",
      "",
      "x".repeat(500),
    ]);
    // De-duplicated case-insensitively, trimmed, and one term is a phrase not
    // an essay — the same treatment a resolved subject's terms get.
    expect(out.keyterms).toEqual(["Michaelis-Menten", "Vmax", "x".repeat(60)]);
  });

  it("is ignored when the subject resolves, so a client cannot redirect the bias", async () => {
    const resolved = await subjectVoiceConfig("nobody", "course_transformers_w4", ["totally", "unrelated", "words"]);
    expect(resolved.keyterms.length).toBeGreaterThan(0);
    expect(resolved.keyterms).not.toContain("totally");
  });

  it("does not borrow another syllabus when the id resolves to nothing and there is no hint", async () => {
    // A null id falls back to the default starter subject on purpose, so the
    // case that matters is an id that names something real to nobody.
    expect((await subjectVoiceConfig("nobody", "subject_nope")).keyterms).toEqual([]);
  });
});

describe("the language picker", () => {
  it("offers Automatic, and it is the default", () => {
    expect(LANGUAGE_PRESETS[0]).toEqual({ value: "multi", label: "Automatic" });
  });

  it("puts the default on the model whose words settle one at a time", () => {
    // `en` pins universal-3-5-pro, which holds every word until end of turn;
    // `multi` runs the multilingual model that finalises them as they land.
    expect(toStreamLanguage(LANGUAGE_PRESETS[0].value)).toBe(AUTO_LANGUAGE);
  });

  it("never offers a code the streaming socket would reject outright", () => {
    for (const preset of LANGUAGE_PRESETS) {
      // Either the socket takes it, or it maps to automatic. Neither closes.
      expect(toStreamLanguage(preset.value)).toBeTruthy();
    }
  });
});
