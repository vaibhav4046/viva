import type { ReactNode } from "react";
import { CorrectionMark, StatusChip } from "@/components/ui/exam";
import type { Debrief, Standing } from "@/lib/oral/debrief";
import { PrintButton } from "./PrintButton";
import "./oral.css";

/**
 * The debrief sheet: what the exam recorded, marked strong, shaky or weak with
 * the turn evidence, the misconceptions caught against the learner's pages, and
 * tomorrow's plan. Printable: the print stylesheet in oral.css hides everything
 * else. Server-safe apart from the print button.
 */

const TONE: Record<Standing, "success" | "warning" | "correction"> = { strong: "success", shaky: "warning", weak: "correction" };
const WORD: Record<Standing, string> = { strong: "Strong", shaky: "Shaky", weak: "Weak" };

export function DebriefSheet({ debrief, level = 2, actions }: { debrief: Debrief; level?: 1 | 2; actions?: ReactNode }) {
  const H = level === 1 ? "h1" : "h2";
  const S = level === 1 ? "h2" : "h3";
  const date = debrief.generatedAt.slice(0, 10);
  const storage = debrief.storage;
  return (
    <article className="debrief" aria-labelledby="debrief-title">
      <header className="grid gap-1">
        <H id="debrief-title" className="debrief-title" tabIndex={-1}>Debrief</H>
        <p className="mono debrief-meta">
          {date}, {debrief.turns} {debrief.turns === 1 ? "answer" : "answers"}, {debrief.interruptions} {debrief.interruptions === 1 ? "interruption" : "interruptions"}
        </p>
      </header>

      <section aria-labelledby="debrief-concepts">
        <S id="debrief-concepts" className="debrief-sec">Concepts covered</S>
        {debrief.concepts.length === 0 ? (
          <p className="oral-empty">No concept was tied to a checked answer in this exam, so none is marked. Answer a question that names a concept and it appears here with the evidence.</p>
        ) : (
          <table>
            <caption>Each concept is marked from what was checked against your pages in this exam.</caption>
            <thead>
              <tr><th scope="col">Concept</th><th scope="col">Standing</th><th scope="col">Evidence from your answers</th></tr>
            </thead>
            <tbody>
              {debrief.concepts.map((c) => (
                <tr key={c.conceptId}>
                  <th scope="row">{c.name}</th>
                  <td data-label="Standing"><StatusChip tone={TONE[c.standing]}>{WORD[c.standing]}</StatusChip></td>
                  <td data-label="Evidence">
                    <ul className="debrief-evidence">
                      {c.evidence.map((e, i) => (
                        <li key={i}>
                          <q>{e.learner}</q> {e.result}
                          {e.page != null ? <>, <span className="mono">p. {e.page}</span></> : null}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="debrief-misc">
        <S id="debrief-misc" className="debrief-sec">Misconceptions caught</S>
        {debrief.misconceptions.length === 0 ? (
          <p className="oral-empty">Your pages contradicted nothing you said in this exam.</p>
        ) : (
          <ul className="debrief-misc">
            {debrief.misconceptions.map((m, i) => (
              <li key={i}>
                <p>
                  <span className="mono debrief-meta">You said: </span>
                  <CorrectionMark>{m.learnerSaid}</CorrectionMark>
                </p>
                <blockquote className="passage-quoted rounded-md p-3" style={{ margin: 0, fontSize: "var(--fs-body-sm)" }}>
                  <span className="mono">{m.material.page != null ? `p. ${m.material.page}` : "page not recorded"}</span>{" "}
                  {m.material.quote}
                </blockquote>
                {m.conceptName ? <p className="debrief-note">Concept: {m.conceptName}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="debrief-plan">
        <S id="debrief-plan" className="debrief-sec">Tomorrow, {debrief.plan.totalMinutes} minutes</S>
        {debrief.plan.steps.length === 0 ? (
          <p className="oral-empty">Nothing is due. Come back after your next exam and the plan is built from it.</p>
        ) : (
          <ol className="debrief-plan">
            {debrief.plan.steps.map((s) => (
              <li key={s.order}>
                <span className="mono">{s.order}.</span>
                <span>
                  <strong>{s.conceptName ?? "Write it down"}</strong>
                  <span className="debrief-note" style={{ display: "block" }}>{s.why}</span>
                </span>
                <span className="mono">{s.minutes} min</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="grid gap-2">
        {debrief.citationsDropped > 0 ? (
          <p className="debrief-note">
            {debrief.citationsDropped} {debrief.citationsDropped === 1 ? "quote" : "quotes"} could not be matched word for word to your pages, so it was removed from this sheet.
          </p>
        ) : null}
        {storage ? (
          <p className="debrief-note">
            {storage.durable ? <StatusChip tone="success">Saved</StatusChip> : <StatusChip tone="warning">Not saved</StatusChip>} {storage.note}
          </p>
        ) : null}
        <div className="debrief-actions">
          <PrintButton />
          {actions}
        </div>
      </footer>
    </article>
  );
}
