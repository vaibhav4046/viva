"use client";
import { useSearchParams } from "next/navigation";
import { DebriefArea } from "@/components/oral/DebriefArea";
import { OralScreen } from "@/components/oral/OralScreen";
import { DiagDrawer } from "@/components/oral/OralParts";
import { TypedExam } from "@/components/oral/TypedExam";
import { useOralSession } from "@/components/oral/useOralSession";

/**
 * /oral, the spoken exam. The screen is OralScreen (presentational, also drawn
 * for every state at /dev/oral-states); the session logic is useOralSession.
 * `?diag=1` adds the diagnostics drawer, which shows only events measured in
 * this session.
 */
export default function OralPage() {
  const diag = useSearchParams().get("diag") === "1";
  const s = useOralSession({ diag });

  return (
    <OralScreen
      phase={s.phase}
      state={s.machine.state}
      fatal={s.machine.fatal}
      page={s.page}
      startedAt={s.startedAt}
      counts={{ turns: s.machine.turns, toolCalls: s.machine.toolCalls, interruptions: s.machine.interruptions }}
      examinerText={s.examinerText}
      examinerCut={s.examinerCut}
      learnerText={s.machine.userPartial}
      lines={s.lines}
      sources={s.sources}
      failure={s.failure}
      notice={s.notice}
      readLevels={s.readLevels}
      canDebrief={s.canDebrief}
      typedSlot={s.typed ? <TypedExam subjectId={s.subjectId} onEntry={s.addEntry} onDone={s.finishTyped} /> : undefined}
      diagSlot={diag ? <DiagDrawer summary={s.diag} discards={s.machine.discards} /> : undefined}
      debriefSlot={<DebriefArea state={s.debrief} onRetry={s.showDebrief} />}
      onStart={s.begin}
      onEnd={s.end}
      onTypeInstead={s.openTyped}
      onFailureAction={s.onFailureAction}
      onDebrief={s.showDebrief}
    />
  );
}
