"use client";
import { EXCERPT } from "@/lib/fixtures/excerpt";
import { ORAL_FAILURES } from "@/lib/oral/failures";
import { initialMachine, type OralState } from "@/lib/oral/machine";
import { deriveDiag } from "./diag";
import type { Scenario } from "./fixtureScenario";
import { OralScreen } from "./OralScreen";
import { DiagDrawer } from "./OralParts";
import { TypedExam } from "./TypedExam";
import type { OralTurn } from "./mic";
import { failureViewFor, type Phase, type SourceCard } from "./model";

/**
 * Dev-only: the real OralScreen fed fixture props so each machine state and each
 * failure screen can be visited, screenshotted and checked with axe. Nothing
 * here is measured. The learner and examiner lines are the scripted landing
 * excerpt, and the pages shown are from the labelled sample course.
 */

const noop = () => {};

const SOURCE: SourceCard = {
  id: "fixture-source",
  claim: EXCERPT.learnerAnswer,
  verdict: "contradicted",
  quote: EXCERPT.passage.match,
  spans: [EXCERPT.passage.match],
  page: EXCERPT.passage.page,
  passageId: EXCERPT.passage.passageId,
  method: "llm",
};

const LINES: OralTurn[] = [
  { speaker: "agent", text: EXCERPT.question },
  { speaker: "user", text: EXCERPT.learnerAnswer },
];

type Shape = { phase: Phase; examiner: string; learner: string; sources: SourceCard[]; levels: { learner: number; examiner: number }; lines: OralTurn[]; cut?: boolean; page?: number | null };

function shapeFor(state: OralState): Shape {
  const idle = { phase: "idle" as Phase, examiner: "", learner: "", sources: [], levels: { learner: 0, examiner: 0 }, lines: [] as OralTurn[] };
  switch (state) {
    case "IDLE": return idle;
    case "CONNECTING":
    case "READY": return { ...idle, phase: "running" };
    case "LISTENING": return { phase: "running", examiner: EXCERPT.question, learner: "", sources: [], levels: { learner: 0.08, examiner: 0 }, lines: LINES.slice(0, 1) };
    case "USER_SPEAKING": return { phase: "running", examiner: EXCERPT.question, learner: "It loses track of which words are", sources: [], levels: { learner: 0.62, examiner: 0 }, lines: LINES.slice(0, 1) };
    case "THINKING": return { phase: "running", examiner: EXCERPT.question, learner: EXCERPT.learnerAnswer, sources: [], levels: { learner: 0, examiner: 0 }, lines: LINES };
    case "CHECKING_SOURCE": return { phase: "running", examiner: EXCERPT.question, learner: EXCERPT.learnerAnswer, sources: [SOURCE], levels: { learner: 0, examiner: 0 }, lines: LINES, page: EXCERPT.passage.page };
    case "SPEAKING": return { phase: "running", examiner: EXCERPT.correction, learner: EXCERPT.learnerAnswer, sources: [SOURCE], levels: { learner: 0.02, examiner: 0.55 }, lines: [...LINES, { speaker: "agent", text: EXCERPT.correction }] };
    case "INTERRUPTED": return { phase: "running", examiner: "Not importance. Page 12 says the model can still", learner: "Wait, can you repeat the question?", sources: [SOURCE], levels: { learner: 0.5, examiner: 0 }, lines: LINES, cut: true };
    case "RECOVERING": return { phase: "running", examiner: EXCERPT.question, learner: EXCERPT.learnerAnswer, sources: [SOURCE], levels: { learner: 0, examiner: 0 }, lines: LINES };
    case "ERROR": return { ...idle, phase: "idle" };
    case "ENDED": return { phase: "ended", examiner: EXCERPT.correction, learner: EXCERPT.learnerAnswer, sources: [SOURCE], levels: { learner: 0, examiner: 0 }, lines: [...LINES, { speaker: "agent", text: EXCERPT.correction }] };
  }
}

export function OralFixture({ scenario }: { scenario: Scenario }) {
  let state: OralState = "IDLE";
  let failure = null;
  let notice = null;
  let fatal = false;
  let typed = false;

  if (scenario.kind === "state") {
    state = scenario.state;
    if (state === "ERROR") {
      failure = failureViewFor("socket_error");
      fatal = false;
    }
  } else if (scenario.kind === "failure") {
    const f = ORAL_FAILURES.find((x) => x.id === scenario.id)!;
    const view = failureViewFor(f.id);
    state = f.state;
    fatal = f.fatal;
    if (view.blocking) failure = view;
    else notice = view;
  } else if (scenario.kind === "typed") {
    typed = true;
  }

  const shape = shapeFor(state);
  const machine = { ...initialMachine(), state, fatal };
  const running = shape.phase === "running" || (shape.phase === "idle" && state !== "IDLE" && state !== "ERROR");
  const phase: Phase = failure && state === "ERROR" ? "idle" : running ? "running" : shape.phase;

  return (
    <OralScreen
      phase={phase}
      state={machine.state}
      fatal={machine.fatal}
      page={shape.page ?? null}
      startedAt={null}
      counts={{ turns: 2, toolCalls: shape.sources.length, interruptions: shape.cut ? 1 : 0 }}
      examinerText={shape.examiner}
      examinerCut={shape.cut}
      learnerText={shape.learner}
      lines={shape.lines}
      sources={shape.sources}
      failure={failure}
      notice={notice}
      fixedLevels={shape.levels}
      typedSlot={typed ? <TypedExam subjectId={null} onEntry={noop} onDone={noop} /> : undefined}
      diagSlot={scenario.kind === "diag" ? <DiagDrawer summary={deriveDiag([])} /> : undefined}
      canDebrief={false}
      onStart={noop}
      onEnd={noop}
      onTypeInstead={noop}
      onFailureAction={noop}
    />
  );
}
