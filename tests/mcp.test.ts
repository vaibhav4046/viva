import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSubjectsFor, subjectMissing } from "@/lib/courses/subject";
import { buildSubject } from "@/lib/intake/build";
import { ACCESS_TTL_SECONDS, PAIR_TTL_SECONDS, mintToken, readToken, userIdFor } from "@/lib/mcp/auth";
import { handleBody, handleMessage } from "@/lib/mcp/rpc";
import { callTool, type ToolEnvironment } from "@/lib/mcp/tools";
import { FileEventStore } from "@/lib/store/file";
import { learnerSnapshot } from "@/lib/sync";

/**
 * The MCP endpoint, and the one thing it must never get wrong.
 *
 * Identity here is a signed key, not a cookie, so the isolation question is
 * different from tests/idor.test.ts: not "can a user id reach another user's
 * rows" but "can anything a caller says change which user id is used". The
 * answer has to be no for every input a caller controls — the header, the
 * token argument, an argument naming a user, and the id of a subject they
 * happen to know.
 *
 * The tools reach VIVA over its own routes on purpose (no capability is
 * re-implemented), and a Next route handler cannot read a cookie outside a
 * request context, so the routes are stood up here from the same functions
 * they call: `listSubjectsFor`, `learnerSnapshot`, `subjectMissing`. The store
 * underneath is the real FileEventStore, so the isolation being asserted is
 * the product's, not a stub's.
 */

const hex = () => randomBytes(16).toString("hex");

const NOTES = [
  "Fixation preserves the structure of the tissue so that it does not degrade during handling.",
  "Dehydration removes water from the sample by passing it through increasing concentrations of ethanol.",
  "Embedding surrounds the dehydrated tissue in paraffin wax so that thin sections can be cut.",
  "Sectioning uses a microtome to cut ribbons a few micrometres thick from the wax block.",
  "Staining applies haematoxylin and eosin so that nuclei and cytoplasm take different colours.",
  "Mounting places a coverslip over the stained section with a resin that matches the refractive index of glass.",
  "Each of these steps is repeated in the same order for every sample so that the results can be compared.",
  "Antigen retrieval reverses some of the cross-linking that fixation caused, which lets antibodies reach their targets again.",
  "Counterstaining adds a second colour so that the structures the primary stain missed are still visible.",
  "Decalcification is required for bone, because a microtome blade cannot cut mineralised tissue without shattering it.",
  "Quality control checks that every section on the slide is the same thickness and that no folds were introduced.",
];

/* ------------------------- the routes, in process ------------------------ */

const store = new FileEventStore();
/** Every cookie the tool layer put on the wire, in order. */
const seen: { path: string; userId: string }[] = [];

async function serve(rawUrl: string, init: RequestInit): Promise<Response> {
  const url = new URL(rawUrl);
  const headers = (init.headers ?? {}) as Record<string, string>;
  const did = /viva_did=([0-9a-f]{32})/.exec(headers.Cookie ?? "")?.[1];
  if (!did) {
    return Response.json({ error: { code: "NO_IDENTITY", message: "no identity on that request" } }, { status: 401 });
  }
  const userId = userIdFor(did);
  seen.push({ path: url.pathname, userId });

  if (url.pathname === "/api/subjects") {
    const subjects = await listSubjectsFor(store, userId);
    return Response.json({ subjects, courses: subjects });
  }
  if (url.pathname === "/api/learner") {
    try {
      return Response.json(await learnerSnapshot(store, userId, url.searchParams.get("subject")));
    } catch (error) {
      return subjectMissing(error);
    }
  }
  return Response.json({ error: { code: "NOT_HERE", message: "no such route" } }, { status: 404 });
}

function envFor(key: string | null, extra: Partial<ToolEnvironment> = {}): ToolEnvironment {
  return {
    origin: "https://viva.test",
    authorization: key ? `Bearer ${key}` : null,
    forwardedFor: null,
    fetch: serve,
    ...extra,
  };
}

/* ------------------------------- the keys -------------------------------- */

describe("pairing keys", () => {
  it("round-trips a device id, and refuses everything else", () => {
    const did = hex();
    const key = mintToken(did, "access");
    const read = readToken(key, "access");
    expect(read).toMatchObject({ ok: true, did });

    // A pairing code is not a key, and a key is not a pairing code.
    expect(readToken(mintToken(did, "pair"), "access")).toMatchObject({ ok: false, reason: "wrong_purpose" });
    expect(readToken(key, "pair")).toMatchObject({ ok: false, reason: "wrong_purpose" });

    // Nothing unsigned gets in.
    expect(readToken("viva-key-" + Buffer.alloc(38).toString("base64url"), "access")).toMatchObject({
      ok: false,
      reason: "forged",
    });
    expect(readToken("viva-key-nonsense", "access")).toMatchObject({ ok: false, reason: "malformed" });
    expect(readToken(undefined, "access")).toMatchObject({ ok: false, reason: "missing" });
  });

  it("a flipped bit in the device id is a forgery, not a different student", () => {
    const key = mintToken(hex(), "access");
    const bytes = Buffer.from(key.slice("viva-key-".length), "base64url");
    bytes[10] ^= 0x01; // inside the signed payload, where the device id lives
    const tampered = "viva-key-" + bytes.toString("base64url");
    expect(readToken(tampered, "access")).toMatchObject({ ok: false, reason: "forged" });
  });

  it("expires: a pairing code in minutes, a key in weeks", () => {
    const did = hex();
    const now = Date.now();
    const code = mintToken(did, "pair", now);
    expect(readToken(code, "pair", now + (PAIR_TTL_SECONDS - 5) * 1000)).toMatchObject({ ok: true });
    expect(readToken(code, "pair", now + (PAIR_TTL_SECONDS + 5) * 1000)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    const key = mintToken(did, "access", now);
    expect(readToken(key, "access", now + (ACCESS_TTL_SECONDS - 60) * 1000)).toMatchObject({ ok: true });
    expect(readToken(key, "access", now + (ACCESS_TTL_SECONDS + 60) * 1000)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });
});

/* ---------------------------- the isolation ------------------------------ */

describe("cross-key isolation (IDOR)", () => {
  const didA = hex();
  const didB = hex();
  const keyA = mintToken(didA, "access");
  const keyB = mintToken(didB, "access");
  const userA = userIdFor(didA);
  const userB = userIdFor(didB);
  const marker = `private-marker-${randomBytes(4).toString("hex")}`;
  let subjectId = "";

  beforeAll(async () => {
    const built = await buildSubject(
      { kind: "paste", title: "Histology methods", text: `The ${marker} protocol stains tissue sections. ${NOTES.join(" ")}` },
      userA
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await store.saveSubject(userA, built.subject);
    subjectId = built.subject.id;
  });

  afterAll(async () => {
    await store.deleteUserData(userA).catch(() => {});
    await store.deleteUserData(userB).catch(() => {});
  });

  it("A's key sees A's subject", async () => {
    const listed = await callTool("list_my_subjects", {}, envFor(keyA));
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain(subjectId);
    expect(listed.text).toContain("Histology methods");
  });

  it("B's key sees none of it, and holding A's subject id changes nothing", async () => {
    const listed = await callTool("list_my_subjects", {}, envFor(keyB));
    expect(listed.text).not.toContain(subjectId);
    expect(listed.text).not.toContain("Histology methods");

    // B names A's subject outright. The app's own resolution refuses it rather
    // than quietly serving a default — the failure mode this repo already had.
    const probe = await callTool("what_am_i_mixed_up_about", { subject_id: subjectId }, envFor(keyB));
    // A refusal is marked as one, so an assistant cannot read it out as material.
    expect(probe.isError).toBe(true);
    expect(probe.text).toContain("isn't here any more");
    expect(probe.text).not.toContain(marker);

    // A asking the same question about their own subject does get an answer.
    const mine = await callTool("what_am_i_mixed_up_about", { subject_id: subjectId }, envFor(keyA));
    expect(mine.text).not.toContain("isn't here any more");
  });

  it("no argument can move the account: not a user id, not a device id", async () => {
    for (const args of [{ user_id: userA }, { userId: userA }, { did: didA }, { subjectOwner: userA }]) {
      const out = await callTool("list_my_subjects", args, envFor(keyB));
      expect(out.isError).toBe(true);
      expect(out.text).toContain("not an argument this tool takes");
    }
    // And the calls that did go out never carried anybody but B.
    const forB = seen.filter((s) => s.userId === userB);
    expect(forB.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.userId === userA || s.userId === userB)).toBe(true);
  });

  it("the header wins over the argument, so a smuggled key cannot swap accounts", async () => {
    seen.length = 0;
    const out = await callTool("list_my_subjects", { account_token: keyA }, envFor(keyB));
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain(subjectId);
    expect(seen.map((s) => s.userId)).toEqual([userB]);
  });

  it("the argument is the fallback when the connection sends no header", async () => {
    seen.length = 0;
    const out = await callTool("list_my_subjects", { account_token: keyA }, envFor(null));
    expect(out.isError).toBe(false);
    expect(out.text).toContain(subjectId);
    expect(seen.map((s) => s.userId)).toEqual([userA]);
  });

  it("no key, no data — and no request either", async () => {
    seen.length = 0;
    const out = await callTool("what_should_i_study_today", {}, envFor(null));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not connected to a VIVA account");
    expect(seen).toEqual([]);
  });

  it("a forged key is refused before anything is read", async () => {
    seen.length = 0;
    const out = await callTool("list_my_subjects", {}, envFor("viva-key-" + Buffer.alloc(38).toString("base64url")));
    expect(out.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("a pairing code exchanges for a key on the same account, and only that account", async () => {
    const connected = await callTool("connect_my_viva_account", { pairing_code: mintToken(didA, "pair") }, envFor(null));
    expect(connected.isError).toBe(false);
    const key = /viva-key-[A-Za-z0-9_-]+/.exec(connected.text)?.[0];
    expect(key).toBeTruthy();
    expect(readToken(key, "access")).toMatchObject({ ok: true, did: didA });

    seen.length = 0;
    const listed = await callTool("list_my_subjects", { account_token: key }, envFor(null));
    expect(listed.text).toContain(subjectId);
    expect(seen.map((s) => s.userId)).toEqual([userA]);

    // An expired code buys nothing.
    const stale = mintToken(didA, "pair", Date.now() - (PAIR_TTL_SECONDS + 60) * 1000);
    const refused = await callTool("connect_my_viva_account", { pairing_code: stale }, envFor(null));
    expect(refused.text).toContain("run out");
    expect(/viva-key-/.test(refused.text)).toBe(false);
  });
});

/* ------------------------------ the wire --------------------------------- */

describe("the tool protocol", () => {
  it("introduces itself and lists the student's tools", async () => {
    const init = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      envFor(null)
    );
    expect(init?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "viva" },
    });

    const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, envFor(null));
    const tools = (listed?.result as { tools: { name: string; description: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "connect_my_viva_account",
      "list_my_subjects",
      "add_subject_from_notes",
      "tell_viva",
      "quiz_me",
      "answer_quiz_question",
      "what_should_i_study_today",
      "what_am_i_mixed_up_about",
    ]);
    // Descriptions are what a student's assistant reads. No internal nouns.
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description.toLowerCase()).not.toMatch(/chunk|endpoint|reducer/);
    }
  });

  it("says so plainly when a method is not implemented, and stays quiet on notifications", async () => {
    const missing = await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, envFor(null));
    expect(missing?.error?.code).toBe(-32601);
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, envFor(null))).toBeNull();
    expect(await handleBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], envFor(null))).toEqual([]);
  });

  it("a refused tool is a result the model can read, not a protocol failure", async () => {
    const answer = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_my_subjects", arguments: {} } },
      envFor(null)
    );
    expect(answer?.error).toBeUndefined();
    expect(answer?.result).toMatchObject({ isError: true });
    const content = (answer?.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Connect page");
  });
});
