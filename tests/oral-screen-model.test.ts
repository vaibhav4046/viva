import { describe, expect, it } from "vitest";
import { ORAL_STATES } from "@/lib/oral/machine";
import { COURSES } from "@/lib/courses";
import { resolveConceptId } from "@/lib/oral/debrief";
import { ORAL_FAILURES } from "@/lib/oral/failures";
import { deriveDiag } from "@/components/oral/diag";
import { meterLevel, rmsOf, smoothLevel } from "@/components/oral/levels";
import {
  controlsFor,
  failureViewFor,
  failureViewFromMessage,
  isShortcut,
  methodLabel,
  outcomeOfTool,
  stateHint,
  stateLine,
} from "@/components/oral/model";

const DASH = /[â€“â€”!]/;

describe("state line", () => {
  it("has words for all twelve states and none is empty", () => {
    for (const s of ORAL_STATES) {
      expect(stateLine(s).length).toBeGreaterThan(2);
      expect(stateLine(s)).not.toMatch(DASH);
    }
  });
  it("names the page once it is known, and says 'your pages' before that", () => {
    expect(stateLine("CHECKING_SOURCE")).toBe("Checking your pages");
    expect(stateLine("CHECKING_SOURCE", { page: 19 })).toBe("Checking page 19");
  });
  it("hints never carry a dash or an exclamation mark, and the recovery hint states the resume window", () => {
    for (const s of ORAL_STATES) expect(stateHint(s)).not.toMatch(DASH);
    expect(stateHint("RECOVERING")).toContain("30 seconds");
  });
});

describe("controls", () => {
  it("offers Start when stopped and End when live, never both", () => {
    expect(controlsFor("idle", "IDLE", false)).toEqual({ start: true, end: false });
    expect(controlsFor("loading", "IDLE", false)).toEqual({ start: false, end: false });
    expect(controlsFor("running", "SPEAKING", false)).toEqual({ start: false, end: true });
    expect(controlsFor("running", "ERROR", true)).toEqual({ start: true, end: false });
    expect(controlsFor("running", "ERROR", false)).toEqual({ start: false, end: true });
    expect(controlsFor("ended", "ENDED", false)).toEqual({ start: true, end: false });
  });
  it("recognises only Alt+Shift+M", () => {
    const base = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: "KeyM" };
    expect(isShortcut(base)).toBe(true);
    expect(isShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isShortcut({ ...base, code: "Space" })).toBe(false);
  });
});

describe("failure screens", () => {
  it("has a titled screen with a next action for every failure in the table", () => {
    for (const f of ORAL_FAILURES) {
      const v = failureViewFor(f.id);
      expect(v.title.length).toBeGreaterThan(3);
      expect(v.message).toBe(f.message);
      expect(v.cause).toBe(f.cause);
      expect(v.title + v.message).not.toMatch(DASH);
      // Blocking failures always offer a way forward. Notices may just inform.
      if (v.blocking) expect(v.actions.length).toBeGreaterThan(0);
    }
  });
  it("maps a thrown sentence back to its failure, and falls back to a generic screen, never blank", () => {
    const denied = ORAL_FAILURES.find((f) => f.id === "mic_denied")!;
    expect(failureViewFromMessage(denied.message).id).toBe("mic_denied");
    const unknown = failureViewFromMessage("Some new thing broke");
    expect(unknown.id).toBe("generic");
    expect(unknown.message).toBe("Some new thing broke");
    expect(unknown.actions).toContain("retry");
  });
});

describe("tool outcomes feed the debrief record", () => {
  const verified = {
    verdict: "contradicted", quote: "Multi-head attention runs the query-key-value computation h times in parallel", page: 15,
    passage_id: "ch_mh_1", quote_spans: ["Multi-head attention runs the query-key-value computation h times in parallel"], method: "llm",
  };
  it("turns a verify_claim verdict into an entry and a source card with the page", () => {
    const o = outcomeOfTool("verify_claim", { claim: "it runs a single head" }, verified, "c1");
    expect(o.entry).toMatchObject({ kind: "claim", verdict: "contradicted", page: 15, passageId: "ch_mh_1", learner: "it runs a single head" });
    expect(o.source).toMatchObject({ page: 15, method: "llm", verdict: "contradicted" });
    expect(o.page).toBe(15);
  });
  it("records not_in_material without a source card", () => {
    const o = outcomeOfTool("verify_claim", { claim: "x is y" }, { verdict: "not_in_material", quote: null, page: null, passage_id: null }, "c2");
    expect(o.entry).toMatchObject({ verdict: "not_in_material", quote: null });
    expect(o.source).toBeNull();
  });
  it("records a graded answer, and ignores tools and shapes it does not know", () => {
    expect(outcomeOfTool("grade_my_answer", { answer: "order" }, { verdict: "partial" }, "c3").entry).toEqual({ kind: "answer", conceptId: null, learner: "order", grade: "partial" });
    expect(outcomeOfTool("grade_my_answer", { answer: "order" }, { verdict: "great" }, "c4").entry).toBeNull();
    expect(outcomeOfTool("search_my_material", { query: "q" }, { found: true }, "c5").entry).toBeNull();
    expect(outcomeOfTool("verify_claim", {}, verified, "c6").entry).toBeNull();
  });
  it("labels a lexical method as not a confirmation", () => {
    expect(methodLabel("lexical", "supported")).toContain("not a confirmation");
    expect(methodLabel("llm", "supported")).toContain("checked by code");
  });
});

describe("levels", () => {
  it("computes RMS of a known block", () => {
    expect(rmsOf([])).toBe(0);
    expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 6);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.1)).toBeCloseTo(0.5, 6);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(Number.NaN)).toBe(0);
  });
  it("rises faster than it falls", () => {
    const up = smoothLevel(0, 1);
    const down = 1 - smoothLevel(1, 0);
    expect(up).toBeGreaterThan(down);
  });
});

describe("diagnostics derive only from events that happened", () => {
  it("is empty for an empty trace", () => {
    const d = deriveDiag([]);
    expect(d).toMatchObject({ events: 0, toSessionReadyMs: null, toFirstAudioMs: null, bargeIns: [], tools: [], turns: 0, partials: [], socket: [] });
  });
  it("measures ready, first audio, barge-in, tool latency and the partial timeline from a scripted trace", () => {
    const d = deriveDiag([
      { t: 1000, kind: "ui.start" },
      { t: 1100, kind: "ws.connect" },
      { t: 1900, kind: "ws.recv", type: "session.ready" },
      { t: 2400, kind: "audio.play" },
      { t: 5000, kind: "ws.recv", type: "input.speech.started" },
      { t: 5002.5, kind: "barge_in.flush.end" },
      { t: 5200, kind: "ws.recv", type: "transcript.user.delta", text: "wait can" },
      { t: 6000, kind: "ws.recv", type: "transcript.user", text: "wait can you repeat" },
      { t: 6100, kind: "tool.http.start", call_id: "a", name: "verify_claim" },
      { t: 6740, kind: "tool.http.end", call_id: "a", name: "verify_claim" },
    ]);
    expect(d.toSessionReadyMs).toBe(900);
    expect(d.toFirstAudioMs).toBe(1400);
    expect(d.bargeIns).toEqual([{ atMs: 4003, stopMs: 2.5 }]);
    expect(d.tools).toEqual([{ name: "verify_claim", ms: 640, ok: true, atMs: 5100 }]);
    expect(d.turns).toBe(1);
    expect(d.partials).toEqual([{ atMs: 4200, text: "wait can" }]);
    expect(d.socket.map((s) => s.label)).toEqual(["ws.connect", "session.ready"]);
  });
});

describe("concept names from verify_claim", () => {
  it("resolves a spoken concept name to the concept id, and falls back to the learner words", () => {
    const concepts = COURSES.course_transformers_w4.concepts;
    const named = outcomeOfTool("verify_claim", { claim: "it runs a single head", concept: "Multi-head attention" }, { verdict: "not_in_material" }, "n1");
    expect(named.entry).toMatchObject({ conceptId: "Multi-head attention" });
    expect(resolveConceptId(concepts, "Multi-head attention", "it runs a single head")).toBe("c_multihead");
    expect(resolveConceptId(concepts, null, "multi-head attention runs one head")).toBe("c_multihead");
    expect(resolveConceptId(concepts, "no such concept", "nothing relevant here")).toBeNull();
  });
});
