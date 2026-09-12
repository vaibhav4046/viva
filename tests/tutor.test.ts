import { describe, expect, it } from "vitest";
import { tutorRespond } from "@/lib/tutor";

describe("socratic policy", () => {
  it("conceptual confusion gets a hint, not an answer dump", () => {
    const t = tutorRespond({ intent: "confusion", cleanedTranscript: "I don't understand positional encoding.", conceptName: "Positional information", conceptId: "c_position", evidenceIds: ["ch_pos_1"] });
    expect(t.strategy).toBe("socratic");
    expect(t.text.length).toBeLessThan(600);
  });
  it("jargon-free request stays readable", () => {
    const t = tutorRespond({ intent: "explain", cleanedTranscript: "Explain it without jargon.", conceptName: "Positional information", conceptId: "c_position", evidenceIds: ["ch_pos_1"] });
    expect(t.text).toMatch(/meeting|name tag|order/i);
  });
  it("quiz request produces a question, not an answer", () => {
    const t = tutorRespond({ intent: "quiz_request", cleanedTranscript: "Quiz me on it.", conceptName: "Positional information", conceptId: "c_position", evidenceIds: ["ch_pos_1"] });
    expect(t.text).toMatch(/\?/);
  });
});
