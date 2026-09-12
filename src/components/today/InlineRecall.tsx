"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ResultBlock } from "@/components/ui/ResultBlock";
import type { ExamAnswerResponse, ExamQuestion } from "./types";

const VERDICT_CHIP: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-cognition)", label: "CORRECT" },
  partial: { color: "var(--color-band-getting)", label: "PARTIAL" },
  incorrect: { color: "var(--color-band-mixed)", label: "MISCONCEPTION" },
};

/**
 * Inline one-question recall: POST /api/exam/start → answer → POST /api/exam/answer.
 * Nothing is written until the server answers 200; on failure the error banner's
 * retry resubmits the SAME answer text, so a network blip can't drop the event.
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
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState<ExamQuestion | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "scoring">("loading");
  const [answer, setAnswer] = useState("");
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

  useEffect(() => {
    if (q && !result) inputRef.current?.focus();
  }, [q, result]);

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
        setAnswer("");
        onAnswered?.();
      } catch {
        setError({ message: "Couldn't score that answer — it may not have been recorded.", retry: () => void submit(value) });
      } finally {
        setPhase("ready");
      }
    },
    [q, courseId, onAnswered]
  );

  return (
    <section
      aria-label={`Inline recall — ${conceptName}`}
      className="rounded-lg border p-4"
      style={{ background: "var(--color-panel)", borderColor: "var(--color-hairline)" }}
    >
      {phase === "loading" && !q ? <LoadingBlock label={`Loading a question on ${conceptName}…`} lines={2} /> : null}

      {q ? (
        <>
          <p className="eyebrow">recall · {conceptName}</p>
          <p className="heading mt-1 text-base leading-snug">{q.question}</p>

          {!result ? (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(answer);
              }}
            >
              <label htmlFor={`${uid}-answer`} className="sr-only">
                Your answer for {conceptName}
              </label>
              <input
                ref={inputRef}
                id={`${uid}-answer`}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Type your answer — no notes"
                className="w-full min-w-0 rounded-lg border px-4 py-3 text-sm"
                style={{ background: "var(--color-graphite)", borderColor: "var(--color-hairline)" }}
              />
              <button
                type="submit"
                className="btn-ghost shrink-0 !py-2"
                disabled={!answer.trim() || phase === "scoring"}
                aria-busy={phase === "scoring"}
              >
                {phase === "scoring" ? "Scoring…" : "Answer"}
              </button>
            </form>
          ) : (
            <div className="mt-3 space-y-3" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className="chip"
                  style={{ color: VERDICT_CHIP[result.verdict]?.color, borderColor: VERDICT_CHIP[result.verdict]?.color }}
                >
                  {VERDICT_CHIP[result.verdict]?.label ?? result.verdict}
                </span>
                <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                  {typeof result.delta === "number"
                    ? `mastery ${result.delta > 0 ? "+" : ""}${Math.round(result.delta * 100)} pts`
                    : ""}
                  {result.reason ? `${typeof result.delta === "number" ? " · " : ""}${result.reason}` : ""}
                </span>
              </div>
              {result.correctPoints && result.correctPoints.length > 0 ? (
                <ResultBlock tone="correct">{result.correctPoints.join(" ")}</ResultBlock>
              ) : null}
              {result.missingPoints && result.missingPoints.length > 0 ? (
                <ResultBlock tone="missing">{result.missingPoints.join(" ")}</ResultBlock>
              ) : null}
              {result.possibleMisconception ? (
                <ResultBlock tone="misconception">{result.possibleMisconception}</ResultBlock>
              ) : null}
              <ResultBlock tone="next">{result.feedback}</ResultBlock>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost !py-2 text-sm" onClick={() => { setResult(null); setAnswer(""); }}>
                  Answer once more
                </button>
                <button type="button" className="btn-ghost !py-2 text-sm" onClick={() => { setResult(null); setQ(null); void load(); }}>
                  New question
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      {error ? (
        <div className={q ? "mt-3" : undefined}>
          <ErrorBanner message={error.message} onRetry={error.retry} retryLabel="Try again" />
        </div>
      ) : null}
    </section>
  );
}
