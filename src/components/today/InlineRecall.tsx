"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MicButton } from "@/components/voice/MicButton";
import { DEFAULT_COURSE_ID } from "@/components/course/CoursePicker";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { QuizQuestion, QuizVerdictPanel, type QuizAssessment } from "@/components/QuizCard";
import type { ExamAnswerResponse, ExamQuestion } from "./types";

/**
 * Inline one-question recall: POST /api/exam/start → answer → POST /api/exam/answer.
 * Nothing is written until the server answers 200; on failure the error banner's
 * retry resubmits the SAME answer text, so a network blip can't drop the event.
 *
 * The answer comes in through the mic, with the typed box underneath it — the
 * same control as /study and /exam. It used to be a bare text input, which is
 * why the mic appeared on one screen in six.
 *
 * Only one of these is ever mounted at a time (the page owns the open state),
 * because a mic owns the Space key and the id on the typed box.
 */
export function InlineRecall({
  conceptId,
  conceptName,
  courseId,
  onAnswered,
}: {
  conceptId: string;
  conceptName: string;
  courseId?: string;
  onAnswered?: () => void;
}) {
  const [q, setQ] = useState<ExamQuestion | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "scoring">("loading");
  const [result, setResult] = useState<ExamAnswerResponse | null>(null);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch("/api/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId, ...(courseId ? { courseId } : {}) }),
      });
      if (!res.ok) throw new Error("exam start failed");
      const d = (await res.json()) as ExamQuestion;
      setQ(d);
      setPhase("ready");
    } catch {
      setPhase("ready");
      setError({ message: "Couldn't load a recall question. The server may be starting up.", retry: () => void load() });
    }
  }, [conceptId, courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (value: string) => {
      if (!q || !value.trim()) return;
      setPhase("scoring");
      setError(null);
      try {
        const resolvedCourse = q.courseId ?? courseId;
        const res = await fetch("/api/exam/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionId: q.id,
            answer: value.trim(),
            clientEventId: crypto.randomUUID(),
            ...(resolvedCourse ? { courseId: resolvedCourse } : {}),
          }),
        });
        if (!res.ok) throw new Error("exam answer failed");
        const d = (await res.json()) as ExamAnswerResponse;
        setResult(d);
        onAnswered?.();
      } catch {
        setError({ message: "Couldn't score that answer — it may not have been recorded.", retry: () => void submit(value) });
      } finally {
        setPhase("ready");
      }
    },
    [q, courseId, onAnswered]
  );

  // Stable across renders: an new array each pass would re-register the mic's
  // Space-key listeners every time.
  const micContext = useMemo(() => (q ? [q.question] : []), [q]);

  const assessment: QuizAssessment | null = result
    ? {
        verdict: result.verdict,
        correctPoints: result.correctPoints ?? [],
        missingPoints: result.missingPoints ?? [],
        possibleMisconception: result.possibleMisconception ?? null,
        feedback: result.feedback,
        evidenceIds: result.evidenceIds ?? [],
      }
    : null;

  return (
    <div aria-label={`Recall — ${conceptName}`} className="space-y-3">
      {phase === "loading" && !q ? <LoadingBlock label={`Loading a question on ${conceptName}…`} lines={2} /> : null}

      {q ? (
        <>
          <QuizQuestion eyebrow={`Recall · ${conceptName}`} question={q.question} />

          {!assessment ? (
            <>
              <MicButton
                subjectId={q.courseId ?? courseId ?? DEFAULT_COURSE_ID}
                onSubmit={(t) => void submit(t.text)}
                busy={phase === "scoring"}
                context={micContext}
              />
              {phase === "scoring" ? <LoadingBlock label="Scoring your answer against the source…" lines={2} /> : null}
            </>
          ) : (
            <QuizVerdictPanel
              result={assessment}
              actions={
                <>
                  <button type="button" className="btn-ghost !py-2 text-sm" onClick={() => setResult(null)}>
                    Answer this one again
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !py-2 text-sm"
                    onClick={() => {
                      setResult(null);
                      setQ(null);
                      void load();
                    }}
                  >
                    Next question
                  </button>
                </>
              }
            />
          )}
        </>
      ) : null}

      {error ? <ErrorBanner message={error.message} onRetry={error.retry} retryLabel="Try again" /> : null}
    </div>
  );
}
