import { describe, expect, it } from "vitest";
import { compileTranscript, cleanTranscript } from "@/lib/compiler";

const CASES: [string, string][] = [
  ["I don't understand why attention needs positional encoding.", "confusion"],
  ["I don't get backprop at all.", "confusion"],
  ["Remember this, it feels important.", "remember"],
  ["This looks exam important, save it.", "exam_marker"],
  ["Quiz me on positional encoding tomorrow.", "quiz_request"],
  ["Test me on attention later.", "quiz_request"],
  ["Explain this without jargon.", "explain"],
  ["What is multi-head attention?", "question"],
  ["Why does attention need position?", "question"],
  ["I think ReLU fixes vanishing gradients because negatives become positive.", "claim"],
  ["I believe policy iteration and value iteration are basically the same.", "claim"],
  ["My answer is order.", "claim"],
  ["Teach it back: let me explain attention to you.", "teachback"],
  ["Compare this to CNNs.", "compare"],
  ["What is the difference between policy and value iteration?", "compare"],
  ["Come back to this tomorrow.", "review_request"],
  ["Review this before the exam.", "review_request"],
  ["Actually, correction — I meant keys, not queries.", "correction"],
  ["This relates to what we saw in CNNs.", "connection"],
  ["Attention is a weighted average over values.", "note"],
  ["Enter viva exam.", "quiz_request"],
  ["Turn this into a flashcard.", "quiz_request"],
  ["Explain that simply.", "explain"],
  ["I still don't get why we need a learning rate here.", "confusion"],
  ["That explanation of vanishing gradients was important. Remember it.", "remember"],
];

describe("intent suite (25 phrases)", () => {
  for (const [text, want] of CASES) {
    it(`"${text.slice(0, 48)}…" → ${want}`, () => {
      expect(compileTranscript(text).intent).toBe(want);
    });
  }
});

describe("cleanup preservation", () => {
  it("keeps NOT", () => {
    expect(cleanTranscript("um I do NOT think policy iteration is the same as value iteration")).toMatch(/NOT/);
  });
  it("keeps numbers and names", () => {
    expect(cleanTranscript("uh Week 4 section 3 has 8 heads")).toMatch(/8 heads/);
  });
  it("keeps uncertainty", () => {
    expect(cleanTranscript("like I sort of don't fully understand why")).toMatch(/don't fully understand/);
  });
});
