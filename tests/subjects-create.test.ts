import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * What /api/subjects/create promises the student.
 *
 * A judge pasted 1,500 words, read "Saving it to your subjects…", got a
 * success screen counting 10 concepts / 8 questions / 12 passages, and then
 * found the subject missing from all eleven reads that followed. The storage
 * needs a DATABASE_URL this route cannot conjure — but promising durability it
 * does not have is a separate defect, and it is this one.
 */

const durable = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    storeDurability: async () => ({
      durable: durable.value,
      backend: durable.value ? "postgres" : "file",
      detail: "stubbed for this test",
    }),
  };
});

const { POST } = await import("@/app/api/subjects/create/route");

const NOTES = [
  "Photosynthesis converts light energy into chemical energy stored as glucose.",
  "The light-dependent reactions happen in the thylakoid membrane and split water, releasing oxygen.",
  "The Calvin cycle runs in the stroma and fixes carbon dioxide using ATP and NADPH from the light reactions.",
  "Chlorophyll absorbs red and blue light most strongly, which is why leaves look green to us.",
  "Rubisco is the enzyme that fixes carbon dioxide, and it is the most abundant protein on the planet.",
].join(" ");

function paste(text: string): NextRequest {
  return new Request("http://localhost/api/subjects/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "paste", title: "Photosynthesis", text }),
  }) as unknown as NextRequest;
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const body = await res.text();
  return body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("POST /api/subjects/create — storage honesty", () => {
  it("says where the subject actually lives when nothing durable is behind it", async () => {
    durable.value = false;
    const out = await lines(await POST(paste(NOTES)));
    const said = out.filter((l) => typeof l.line === "string").map((l) => String(l.line));
    // Before: said while the student is still watching, not after the fact.
    expect(said[0]).toMatch(/in this browser/i);
    // Instead of "Saving it to your subjects…", which was the false promise.
    expect(said.some((l) => /that is where your subjects live/i.test(l))).toBe(true);
    expect(said.some((l) => /Saving it to your subjects/i.test(l))).toBe(false);
    // And no longer a threat it cannot keep: the record travels back with the
    // response and is handed in again on the next load, so "it might be gone"
    // would now be the untrue sentence.
    expect(said.some((l) => /Open VIVA here again and it is waiting/i.test(l))).toBe(true);
    expect(said.some((l) => /not survive|not stored anywhere lasting/i.test(l))).toBe(false);

    const done = out.find((l) => l.subject) as { subject: Record<string, unknown>; record?: Record<string, unknown> } | undefined;
    expect(done).toBeTruthy();
    // The success payload carries the truth too, so a screen cannot miss it.
    expect(done?.subject.durable).toBe(false);
    expect(String(done?.subject.storageNote)).toMatch(/in this browser/i);
    // The whole subject comes with it, which is the only reason the browser can
    // hand it back through POST /api/learner/sync on the next load.
    expect(done?.record?.id).toBe(done?.subject.id);
    expect(Array.isArray(done?.record?.concepts)).toBe(true);
    expect((done?.record?.concepts as unknown[]).length).toBe(done?.subject.concepts);
    expect(Array.isArray(done?.record?.sources)).toBe(true);
  });

  it("says none of that when a write really will survive", async () => {
    durable.value = true;
    const out = await lines(await POST(paste(NOTES)));
    const said = out.filter((l) => typeof l.line === "string").map((l) => String(l.line));
    expect(said.some((l) => /in this browser/i.test(l))).toBe(false);
    expect(said.some((l) => /Saving it to your subjects/i.test(l))).toBe(true);
    const done = out.find((l) => l.subject) as { subject: Record<string, unknown>; record?: Record<string, unknown> } | undefined;
    expect(done?.subject.durable).toBe(true);
    expect(done?.subject.storageNote).toBeNull();
    // The browser gets its copy either way — a durable write is not a reason to
    // make the client fetch back what it just built.
    expect(done?.record?.id).toBe(done?.subject.id);
  });
});

describe("POST /api/subjects/create — the real upload ceiling", () => {
  it("refuses an oversize body before reading it, naming the limit it enforces", async () => {
    const { PDF_MAX_BYTES } = await import("@/lib/intake/pdf");
    const req = new Request("http://localhost/api/subjects/create", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        // The body is never sent: the declared length is enough to refuse.
        "content-length": String(PDF_MAX_BYTES + 1),
      },
      body: "--x--",
    }) as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe("FILE_TOO_LARGE");
    // The number in the sentence comes from the constant, so they cannot drift
    // apart the way the old 15 MB copy drifted from a ~4.5 MB platform limit.
    expect(body.error.message).toContain(`${Math.round(PDF_MAX_BYTES / (1024 * 1024))} MB`);
    expect(body.error.message).not.toMatch(/15 MB/);
  });
});
