import { describe, expect, it } from "vitest";
import { blankMastery } from "@/lib/mastery";
import type { ConceptMastery } from "@/lib/types";
import {
  MAX_PER_CONCEPT,
  MAX_STAY,
  applyTurn,
  chooseNext,
  rankWeakest,
  turnResultOf,
  type ConceptRef,
  type Turn,
} from "@/lib/oral/next-concept";

const NOW = "2026-09-29T12:00:00.000Z";
const CONCEPTS: ConceptRef[] = [
  { id: "c_self_attention", name: "Self-attention" },
  { id: "c_qkv", name: "Queries, Keys, Values" },
  { id: "c_position", name: "Positional information" },
  { id: "c_multihead", name: "Multi-head attention" },
];

function row(id: string, mastery: number, over: Partial<ConceptMastery> = {}): ConceptMastery {
  return { ...blankMastery(id, NOW), exposureCount: 2, mastery, ...over };
}

/** A stored map from an earlier session: multi-head is the weakest, self-attention the strongest. */
const STORED: Record<string, ConceptMastery> = {
  c_self_attention: row("c_self_attention", 0.81),
  c_qkv: row("c_qkv", 0.56),
  c_multihead: row("c_multihead", 0.38, { failedRecallCount: 1, misconceptionCount: 1 }),
};

const t = (conceptId: string | null, result: Turn["result"]): Turn => ({ conceptId, result });

describe("chooseNext, first question", () => {
  it("starts on the weakest concept in the stored map, as a recall question", () => {
    const next = chooseNext({ concepts: CONCEPTS, mastery: STORED, turns: [] });
    expect(next).toMatchObject({ conceptId: "c_multihead", kind: "recall" });
    expect(next?.reason).toContain("Multi-head attention");
  });

  it("treats a concept with no row as 0.5, so a shaky one still outranks it and a solid one does not", () => {
    const ranked = rankWeakest(CONCEPTS, STORED).map((c) => c.id);
    expect(ranked).toEqual(["c_multihead", "c_position", "c_qkv", "c_self_attention"]);
  });

  it("breaks a tie by the subject's own order", () => {
    const next = chooseNext({ concepts: CONCEPTS, mastery: {}, turns: [] });
    expect(next?.conceptId).toBe("c_self_attention");
  });

  it("returns null when the subject has no concepts", () => {
    expect(chooseNext({ concepts: [], mastery: STORED, turns: [] })).toBeNull();
  });
});

describe("chooseNext, follow-ups depend on the previous verdict", () => {
  it("stays on the concept after an incorrect answer and steps back to recall", () => {
    const next = chooseNext({ concepts: CONCEPTS, mastery: applyTurn(STORED, "c_qkv", "incorrect", NOW), turns: [t("c_qkv", "incorrect")] });
    expect(next).toMatchObject({ conceptId: "c_qkv", kind: "recall" });
    expect(next?.reason).toContain("was not right");
  });

  it("moves to the weakest concept after a correct answer on another concept", () => {
    const next = chooseNext({ concepts: CONCEPTS, mastery: applyTurn(STORED, "c_qkv", "correct", NOW), turns: [t("c_qkv", "correct")] });
    expect(next?.conceptId).toBe("c_multihead");
    expect(next?.reason).toContain("Move to Multi-head attention");
  });

  it("gives a different next question for a correct answer than for an incorrect one, same history", () => {
    const history = [t("c_multihead", "correct"), t("c_position", "correct")];
    const after = (result: Turn["result"]) => {
      const turns = [...history, t("c_qkv", result)];
      const mastery = applyTurn(STORED, "c_qkv", result, NOW);
      return chooseNext({ concepts: CONCEPTS, mastery, turns });
    };
    const good = after("correct");
    const bad = after("incorrect");
    expect(good).not.toEqual(bad);
    expect(bad?.conceptId).toBe("c_qkv");
    expect(good?.conceptId).not.toBe("c_qkv");
  });

  it("follows a partial answer on the same concept with the next kind, not a repeat", () => {
    const next = chooseNext({ concepts: CONCEPTS, mastery: STORED, turns: [t("c_multihead", "partial")] });
    expect(next).toMatchObject({ conceptId: "c_multihead", kind: "why" });
    expect(next?.reason).toContain("only partly right");
  });

  it("stops staying after MAX_STAY misses in a row and moves to another concept", () => {
    expect(MAX_STAY).toBe(2);
    const turns = [t("c_multihead", "incorrect"), t("c_multihead", "incorrect")];
    const mastery = applyTurn(applyTurn(STORED, "c_multihead", "incorrect", NOW), "c_multihead", "incorrect", NOW);
    const next = chooseNext({ concepts: CONCEPTS, mastery, turns });
    expect(next?.conceptId).not.toBe("c_multihead");
    expect(next?.conceptId).toBe("c_position");
    expect(next?.kind).toBe("recall");
  });

  it("does not let a claim the material could not settle change anyone's standing", () => {
    expect(applyTurn(STORED, "c_qkv", "unsettled", NOW).c_qkv.mastery).toBe(STORED.c_qkv.mastery);
    const next = chooseNext({ concepts: CONCEPTS, mastery: STORED, turns: [t("c_qkv", "unsettled")] });
    expect(next?.conceptId).toBe("c_multihead");
  });
});

describe("chooseNext, question kinds alternate", () => {
  it("rotates recall, why, apply, recall while the answers are correct", () => {
    const turns: Turn[] = [];
    let mastery = STORED;
    const kinds: string[] = [];
    const first = chooseNext({ concepts: CONCEPTS, mastery, turns });
    kinds.push(first!.kind);
    let asked = first!.conceptId;
    for (let i = 0; i < 3; i++) {
      turns.push(t(asked, "correct"));
      mastery = applyTurn(mastery, asked, "correct", NOW);
      const next = chooseNext({ concepts: CONCEPTS, mastery, turns })!;
      kinds.push(next.kind);
      asked = next.conceptId;
    }
    expect(kinds).toEqual(["recall", "why", "apply", "recall"]);
  });

  it("goes back to recall after an incorrect answer even when the last kind was apply", () => {
    const turns = [t("c_multihead", "correct"), t("c_multihead", "correct"), t("c_multihead", "incorrect")];
    const next = chooseNext({ concepts: CONCEPTS, mastery: STORED, turns });
    expect(next?.kind).toBe("recall");
  });
});

describe("chooseNext, limits", () => {
  it("skips a concept already asked MAX_PER_CONCEPT times while others remain", () => {
    expect(MAX_PER_CONCEPT).toBe(3);
    const turns = [t("c_multihead", "correct"), t("c_qkv", "correct"), t("c_multihead", "correct"), t("c_qkv", "correct"), t("c_multihead", "correct")];
    // Multi-head is still the lowest stored mastery, and has been asked three times.
    const next = chooseNext({ concepts: CONCEPTS, mastery: STORED, turns });
    expect(next?.conceptId).not.toBe("c_multihead");
  });

  it("falls back to the weakest overall when every concept has hit the cap", () => {
    const one: ConceptRef[] = [CONCEPTS[3]];
    const turns = [t("c_multihead", "correct"), t("c_multihead", "correct"), t("c_multihead", "correct")];
    expect(chooseNext({ concepts: one, mastery: STORED, turns })?.conceptId).toBe("c_multihead");
  });

  it("is deterministic and leaves its inputs untouched", () => {
    const before = JSON.stringify(STORED);
    const turns = [t("c_qkv", "incorrect")];
    const a = chooseNext({ concepts: CONCEPTS, mastery: applyTurn(STORED, "c_qkv", "incorrect", NOW), turns });
    const b = chooseNext({ concepts: CONCEPTS, mastery: applyTurn(STORED, "c_qkv", "incorrect", NOW), turns });
    expect(a).toEqual(b);
    expect(JSON.stringify(STORED)).toBe(before);
    expect(turns).toEqual([t("c_qkv", "incorrect")]);
  });
});

describe("turnResultOf", () => {
  it("maps tool verdicts onto the four results", () => {
    expect(turnResultOf({ kind: "claim", verdict: "supported" })).toBe("correct");
    expect(turnResultOf({ kind: "claim", verdict: "contradicted" })).toBe("incorrect");
    expect(turnResultOf({ kind: "claim", verdict: "not_in_material" })).toBe("unsettled");
    expect(turnResultOf({ kind: "answer", grade: "partial" })).toBe("partial");
  });
});
