"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QuestionCard, StatusChip } from "@/components/ui/exam";
import { KeyboardIcon } from "@/components/ui/icons";
import type { SessionEntry } from "@/lib/oral/debrief";

/**
 * The typed exam: the same questions and the same grader as the written quiz,
 * with no microphone. It is the path for a denied microphone, no device, an
 * insecure page, or a learner who would rather type. Each graded answer is
 * handed up as a debrief entry.
 */

type Question = { id: string; question: string; hint?: string; courseId?: string };
type Graded = { verdict: "correct" | "partial" | "incorrect"; feedback: string; missingPoints: string[]; closed: boolean };
type Status = "loading" | "asking" | "grading" | "graded" | "error";

const TONE = { correct: "success", partial: "warning", incorrect: "correction" } as const;
const WORD = { correct: "Correct", partial: "Partly right", incorrect: "Not yet" } as const;

export function TypedExam({
  subjectId,
  onEntry,
  onDone,
}: {
  subjectId: string | null;
  onEntry: (entry: SessionEntry) => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [question, setQuestion] = useState<Question | null>(null);
  const [graded, setGraded] = useState<Graded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  const nextQuestion = useCallback(async () => {
    setStatus("loading");
    setGraded(null);
    setError(null);
    try {
      const res = await fetch("/api/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subjectId ? { courseId: subjectId } : {}),
      });
      const body = (await res.json().catch(() => null)) as (Question & { error?: { message?: string } }) | null;
      if (!res.ok || !body?.id) throw new Error(body?.error?.message ?? "The next question could not be loaded.");
      setQuestion({ id: body.id, question: body.question, hint: body.hint, courseId: body.courseId });
      setStatus("asking");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The next question could not be loaded. Check your connection and try again.");
      setStatus("error");
    }
  }, [subjectId]);

  useEffect(() => {
    void nextQuestion();
  }, [nextQuestion]);

  useEffect(() => {
    if (status === "asking") answerRef.current?.focus();
  }, [status]);

  async function submit() {
    const text = answerRef.current?.value.trim() ?? "";
    if (!question) return;
    if (!text) {
      setEmpty(true);
      answerRef.current?.focus();
      return;
    }
    setEmpty(false);
    setStatus("grading");
    setError(null);
    try {
      const res = await fetch("/api/exam/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, answer: text, origin: "typed", subjectId: question.courseId ?? subjectId ?? undefined }),
      });
      const body = (await res.json().catch(() => null)) as (Graded & { error?: { message?: string } }) | null;
      if (!res.ok || !body?.verdict) throw new Error(body?.error?.message ?? "That answer could not be checked.");
      setGraded({ verdict: body.verdict, feedback: body.feedback, missingPoints: body.missingPoints ?? [], closed: !!body.closed });
      onEntry({ kind: "answer", conceptId: null, learner: text.slice(0, 2000), grade: body.verdict });
      setStatus("graded");
    } catch (e) {
      // The typed text stays in the box: an error must not cost the learner their answer.
      setError(e instanceof Error ? e.message : "That answer could not be checked. Your text is still here; try again.");
      setStatus("asking");
    }
  }

  return (
    <div className="oral-typed">
      <div className="oral-question">
        {status === "loading" && !question ? (
          <section className="surface-card p-5" role="status" aria-busy="true" style={{ minHeight: "11rem" }}>
            <p className="eyebrow">Question</p>
            <div className="skeleton mt-3" style={{ height: 22, width: "88%" }} />
            <div className="skeleton mt-2" style={{ height: 22, width: "62%" }} />
          </section>
        ) : (
          <QuestionCard label="Question">{question?.question ?? ""}</QuestionCard>
        )}
      </div>

      {error ? (
        <div className="oral-alert" role="alert">
          <h2 className="oral-alert-title">That did not work</h2>
          <p>{error}</p>
          {status === "error" ? (
            <div className="oral-alert-actions"><button type="button" className="btn-primary" onClick={() => void nextQuestion()}>Load the question again</button></div>
          ) : null}
        </div>
      ) : null}

      {status === "graded" && graded ? (
        <div className="oral-result" role="status">
          <StatusChip tone={TONE[graded.verdict]}>{WORD[graded.verdict]}</StatusChip>
          <p>{graded.feedback}</p>
          {graded.closed && graded.missingPoints.length > 0 ? (
            <div>
              <p className="mono" style={{ color: "var(--text-secondary)" }}>What a full answer also covers</p>
              <ul className="list-disc pl-5" style={{ fontSize: "var(--fs-body-sm)" }}>{graded.missingPoints.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          ) : null}
          <div className="oral-alert-actions">
            <button type="button" className="btn-primary" onClick={() => void nextQuestion()}>Next question</button>
            <button type="button" className="btn-ghost" onClick={onDone}>Finish and see the debrief</button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <label className="field-label" htmlFor={`${id}-a`}>Your answer</label>
          <textarea
            id={`${id}-a`}
            ref={answerRef}
            name="answer"
            rows={5}
            maxLength={2000}
            autoComplete="off"
            aria-invalid={empty || undefined}
            aria-describedby={`${id}-h`}
            disabled={status === "loading" && !question}
          />
          <p id={`${id}-h`} className={empty ? "field-error" : "field-hint"}>
            {empty ? "Write an answer first, then check it." : question?.hint ? `Hint: ${question.hint}` : "Answer in your own words. It is checked against your pages."}
          </p>
          <div className="oral-alert-actions">
            <button type="submit" className="btn-primary" aria-busy={status === "grading"} disabled={status === "grading" || status === "loading" || status === "error"}>
              <KeyboardIcon size={18} />
              {status === "grading" ? "Checking your answer" : "Check my answer"}
            </button>
            <button type="button" className="btn-ghost" onClick={onDone}>Finish and see the debrief</button>
          </div>
        </form>
      )}
    </div>
  );
}
