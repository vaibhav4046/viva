import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getCourse } from "@/lib/courses";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import { mergeMastery } from "@/components/mirror";
import { POST as studyTurn } from "@/app/api/study/turn/route";
import { runClaim, TRANSFORMERS } from "./fixtures/claim-corpus";
import type { ConceptMastery } from "@/lib/types";

/**
 * What may move a learner's record, measured against the session that broke it.
 *
 * A student judge pasted two passages off the screen word for word. VIVA
 * answered "That matches p.7" — true, and the right thing to say — and then
 * wrote two SUCCESSFUL RECALLS into the map against Self-attention, a concept
 * neither passage is about and the student never mentioned. /today read it
 * back as "You recalled Self-attention correctly 2 times" and pushed the
 * review out two days. Reproduced on a local server, 2 of 2.
 *
 * Three separate faults, one per block below:
 *
 *   1. reading the source back is not recall. `supportedBy` recognises the
 *      passage's own sentence, which is exactly what a paste is;
 *   2. the concept came from `findConcepts`, which ranks by longest matched
 *      alias — so "attention" (9 characters, in nearly every passage of this
 *      subject) beat "query"/"key"/"value" on a passage about queries, keys
 *      and values. A got-it may only be written on a concept the line that
 *      verified it actually names;
 *   3. "Partly there" recorded neither a hit nor a miss, so an answer with the
 *      two algorithms exactly reversed moved mastery UP by 0.02.
 *
 * And a fourth, on the way the browser's copy is reconciled with the server's.
 */

const COURSE = getCourse("course_transformers_w4");

/** Passage 3 of the shipped Transformers subject, p.7, about queries/keys/values. */
const PASSAGE_3 =
  "Each token is projected into three vectors: a query (what this token is looking for), " +
  "a key (what this token offers to others), and a value (the content carried forward). " +
  "The attention score between token i and token j is the dot product of query i and key j, " +
  "scaled by the square root of the key dimension.";

/** Passage 8, p.16, about multi-head attention. */
const PASSAGE_8 =
  "A single attention head computes one weighted average, which bottlenecks what it can express. " +
  "With eight heads, the model computes eight different averages and combines them, " +
  "so each layer captures several relation types at once instead of one.";

/**
 * The same sentence said back in the student's own words: the source names the
 * tokens ("between token i and token j", "query i and key j") and this does
 * not. Still checkable against the line, and still a recall.
 */
const OWN_WORDS =
  "The attention score is the dot product of a query and a key, scaled by the square root of the key dimension.";

describe("reading the source back is not recall", () => {
  it("marks a verbatim paste as recited and a reworded claim as not", () => {
    const pasted = runClaim(TRANSFORMERS, PASSAGE_3);
    expect(pasted.status).toBe("supported");
    expect(pasted.recited).toBe(true);

    const said = runClaim(TRANSFORMERS, OWN_WORDS);
    expect(said.status).toBe("supported");
    expect(said.recited).toBe(false);
  });

  it("marks a quote of two consecutive passage lines as recited", () => {
    // The shape `claim-recall.test.ts` requires to stay `supported`: the
    // parentheticals dropped, so the first sentence is not one unbroken run —
    // but the second is the line word for word, and one copied line is enough.
    const check = runClaim(
      TRANSFORMERS,
      "Each token is projected into three vectors: a query, a key and a value. " +
        "The attention score between token i and token j is the dot product of query i and key j, " +
        "scaled by the square root of the key dimension."
    );
    expect(check.status).toBe("supported");
    expect(check.recited).toBe(true);
  });
});

describe("a got-it lands on the concept the line that verified it names", () => {
  it("files a paste of the queries/keys/values passage under that concept", () => {
    const check = runClaim(TRANSFORMERS, PASSAGE_3);
    expect(check.status).toBe("supported");
    // Not c_self_attention, which is what the alias "attention" wins on words.
    expect(check.conceptId).toBe("c_qkv");
  });

  it("keeps the routed concept when the supporting line does name it", () => {
    const check = runClaim(TRANSFORMERS, PASSAGE_8);
    expect(check.status).toBe("supported");
    expect(["c_multihead", "c_self_attention"]).toContain(check.conceptId);
  });

  it("credits the concept the line names most, not the one the words guessed", () => {
    // The words route this to Self-attention: the alias "attention" is nine
    // characters and "query"/"key" are five and three. The line that verifies
    // it says query twice and key twice, and attention once.
    const check = runClaim(TRANSFORMERS, OWN_WORDS);
    expect(check.status).toBe("supported");
    expect(check.conceptId).toBe("c_qkv");
  });
});

describe("the reducer only writes a got-it for something that was recalled", () => {
  const at = "2026-09-13T12:00:00.000Z";
  const claim = (extra: Parameters<typeof reduceMastery>[1]) =>
    reduceMastery(blankMastery("c_x", at), extra);

  it("partly there with a diagnosed misconception is a miss, not a nudge upward", () => {
    const r = claim({ intent: "claim", createdAt: at, assessment: "partial", masterySignal: "down" });
    expect(r.next.failedRecallCount).toBe(1);
    expect(r.next.successfulRecallCount).toBe(0);
    expect(r.delta).toBeLessThan(0);
  });

  it("partly there with nothing diagnosed keeps its nudge and logs no miss", () => {
    // Half an answer is still half an answer. What may not happen is the map
    // reading the same either way, which is what "partly there" used to do.
    const r = claim({ intent: "claim", createdAt: at, assessment: "partial", masterySignal: null });
    expect(r.next.successfulRecallCount).toBe(0);
    expect(r.next.failedRecallCount).toBe(0);
    expect(r.delta).toBeGreaterThan(0);
  });

  it("still credits a checked recall", () => {
    const r = claim({ intent: "claim", createdAt: at, assessment: "correct", masterySignal: "up" });
    expect(r.next.successfulRecallCount).toBe(1);
    expect(r.delta).toBeGreaterThan(0);
  });
});

/**
 * The judge watched five of six concepts drop to "Not yet" mid-session, and
 * Self-attention's got-its go 2 → 0. Reproduced on a local file-backed server:
 * a turn answered on one instance leaves the browser holding exposureCount 1
 * with one got-it; the next turn lands on a cold instance whose /tmp is empty,
 * so it folds that one turn alone and answers with exposureCount 1 and no
 * got-it. `mergeMastery` compared exposure counts, found a tie, and handed it
 * to the server — a record built out of strictly less of the session.
 */
function row(over: Partial<ConceptMastery>): ConceptMastery {
  return { ...blankMastery("c_sa", "2026-09-13T12:00:00.000Z"), ...over };
}

describe("the copy that folded more of the session wins", () => {
  const mine = row({
    exposureCount: 1,
    successfulRecallCount: 1,
    mastery: 0.56,
    lastSeenAt: "2026-09-13T12:00:00.000Z",
  });
  const cold = row({
    exposureCount: 1,
    failedRecallCount: 1,
    mastery: 0.44,
    lastSeenAt: "2026-09-13T12:05:00.000Z",
  });

  it("keeps the browser's row when it holds more events than the server folded", () => {
    const merged = mergeMastery({ c_sa: cold }, { c_sa: mine }, [
      { primaryConceptId: "c_sa" },
      { primaryConceptId: "c_sa" },
    ]);
    expect(merged.c_sa.successfulRecallCount).toBe(1);
    expect(merged.c_sa.mastery).toBe(0.56);
  });

  it("takes the server's row once it has folded everything the browser holds", () => {
    const caughtUp = row({ exposureCount: 2, successfulRecallCount: 1, failedRecallCount: 1, mastery: 0.5 });
    const merged = mergeMastery({ c_sa: caughtUp }, { c_sa: mine }, [
      { primaryConceptId: "c_sa" },
      { primaryConceptId: "c_sa" },
    ]);
    expect(merged.c_sa.exposureCount).toBe(2);
    expect(merged.c_sa.mastery).toBe(0.5);
  });

  it("still takes a server row for a concept the browser has never seen", () => {
    const merged = mergeMastery({ c_new: cold }, {}, []);
    expect(merged.c_new).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The same two pastes, over the real route, because the record the judge
 * read is written by `POST /api/study/turn` and not by any function above.
 * ------------------------------------------------------------------ */

let currentUser = "u_credit_default";
vi.mock("@/lib/auth/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/identity")>();
  return { ...actual, resolveIdentity: async () => ({ identity: { userId: currentUser, kind: "demo" as const } }) };
});

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-credit-"));
  process.env.DATA_DIR = tmp;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

function say(text: string): NextRequest {
  return new NextRequest("http://localhost/api/study/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, origin: "typed", subjectId: COURSE.id, clientEventId: `c_${Math.random()}` }),
  });
}

type TurnBody = {
  event: { primaryConceptId: string | null; assessment: string | null; masterySignal: string | null };
  mastery: Record<string, ConceptMastery>;
  claim: { status: string } | null;
};

describe("POST /api/study/turn — pasting the passage back", () => {
  it("logs no successful recall, on any concept", async () => {
    currentUser = "u_credit_paste";
    const first = (await (await studyTurn(say(PASSAGE_3))).json()) as TurnBody;
    const second = (await (await studyTurn(say(PASSAGE_8))).json()) as TurnBody;

    expect(first.claim?.status).toBe("supported");
    expect(first.event.assessment).toBeNull();
    expect(second.event.assessment).toBeNull();
    for (const [id, m] of Object.entries(second.mastery)) {
      expect(m.successfulRecallCount, `${id} was credited`).toBe(0);
    }
  });

  it("files the queries/keys/values passage under queries, keys and values", async () => {
    currentUser = "u_credit_route";
    const body = (await (await studyTurn(say(PASSAGE_3))).json()) as TurnBody;
    expect(body.event.primaryConceptId).toBe("c_qkv");
    expect(body.mastery.c_self_attention).toBeUndefined();
  });

  it("does not debit a second paste that the source itself states", async () => {
    // The first paste asks a question, so the second lands on the answer path
    // and is read as an aside. A sentence the source confirms is not a miss on
    // the way past, whatever a model asked to correct it comes back with.
    currentUser = "u_credit_aside";
    await studyTurn(say(PASSAGE_3));
    const body = (await (await studyTurn(say(PASSAGE_8))).json()) as TurnBody;
    expect(body.claim?.status).toBe("supported");
    expect(body.event.masterySignal).not.toBe("down");
    for (const [id, m] of Object.entries(body.mastery)) {
      expect(m.failedRecallCount, `${id} was debited`).toBe(0);
      expect(m.successfulRecallCount, `${id} was credited`).toBe(0);
    }
  });
});
