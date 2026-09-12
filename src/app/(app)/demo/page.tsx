"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import { Nav } from "@/components/Nav";
import { VoiceButton, type DictationResult } from "@/components/VoiceButton";
import { ThoughtMark } from "@/components/ThoughtMark";
import { Graph } from "@/components/Graph";
import { SourceReader } from "@/components/SourceReader";
import { TutorPanel } from "@/components/TutorPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ResultBlock } from "@/components/ui/ResultBlock";
import {
  CoursePicker,
  DEFAULT_COURSE_ID,
  fetchCourses,
  readCourseParam,
  readStoredCourse,
  writeStoredCourse,
  type CourseMeta,
} from "@/components/course/CoursePicker";
import type { ConceptMastery, LearningEvent } from "@/lib/types";
import { logEvent } from "@/lib/analytics";

type CompileOut = {
  event: LearningEvent;
  tutor: { text: string; evidenceIds: string[]; strategy: string };
  verifier?: { pass: boolean; violations: string[] };
  mastery: Record<string, ConceptMastery>;
  delta: number | null;
  reason: string | null;
  transcription: { origin: "voice" | "typed"; latencyMs: number | null };
  timings?: Record<string, number>;
  traceId?: string;
  mode?: string;
};

type ExamAssessment = {
  verdict: "correct" | "partial" | "incorrect";
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
};

type ConceptLite = { id: string; name: string; description: string };

type Boot = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: ConceptLite[];
  productEvents: { name: string; count: number }[];
};

const GOLDEN_STEPS = [
  'Say: “I don’t understand why attention needs positional encoding.”',
  'Say: “Explain it without jargon.”',
  'Say: “Quiz me on it.” — then answer wrong on purpose (“It wouldn’t know which words are important.”)',
  "Take the hint, answer with order — watch the graph recover.",
];

/** Lowest mastered concept (deterministic) so the detail panel starts useful. */
function weakestConceptId(concepts: ConceptLite[], mastery: Record<string, ConceptMastery>): string | null {
  const ranked = concepts
    .filter((c) => mastery[c.id])
    .sort((a, b) => mastery[a.id].mastery - mastery[b.id].mastery || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? concepts[0]?.id ?? null;
}

export default function DemoPage() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [marks, setMarks] = useState<{ event: LearningEvent; concept: string | null; delta: number | null }[]>([]);
  const [tutor, setTutor] = useState<{ text: string; evidenceIds: string[]; strategy: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compileError, setCompileError] = useState<{ message: string; retry: () => void } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [examQ, setExamQ] = useState<{ id: string; question: string } | null>(null);
  const [examResult, setExamResult] = useState<ExamAssessment | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [priors, setPriors] = useState<Record<string, number>>({});
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  // null until the client resolves ?course → localStorage → default.
  const [courseId, setCourseId] = useState<string | null>(null);
  const conceptsRef = useRef<ConceptLite[]>([]);

  async function refreshMemory() {
    try {
      const r = await fetch("/api/learner/review");
      const d = await r.json();
      setMemory(Array.isArray(d.compound) ? d.compound.slice(0, 2) : []);
    } catch { /* memory is additive, never blocking */ }
  }

  // Resolve the selected course once on the client (hydration-safe).
  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then(setCourses)
        .catch(() => setCourses([]));
      const next = readCourseParam() || readStoredCourse() || DEFAULT_COURSE_ID;
      setCourseId(next);
    })();
  }, []);

  const load = useCallback(async (cid: string) => {
    setBootLoading(true);
    setBootError(null);
    try {
      const r = await fetch(`/api/learner?courseId=${encodeURIComponent(cid)}`);
      if (!r.ok) throw new Error("learner fetch failed");
      const d = await r.json();
      const next: Boot = {
        mastery: d.mastery,
        events: Array.isArray(d.events) ? d.events : [],
        concepts: Array.isArray(d.concepts) ? d.concepts : [],
        productEvents: Array.isArray(d.productEvents) ? d.productEvents : [],
      };
      conceptsRef.current = next.concepts;
      setBoot(next);
      setPriors(d.priors ?? {});
      setSelected((prev) =>
        prev && next.concepts.some((c) => c.id === prev) ? prev : weakestConceptId(next.concepts, next.mastery)
      );
    } catch {
      setBootError("Couldn't load this course. The server may be starting up.");
    } finally {
      setBootLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEvent("demo_started");
    if (courseId) void load(courseId);
    void refreshMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  /** Course switch: persist, clear per-course state, refetch learner + source. */
  function changeCourse(id: string) {
    if (!id || id === courseId) return;
    writeStoredCourse(id);
    setCourseId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("course", id);
      window.history.replaceState(null, "", url.toString());
    } catch { /* no window (prerender) */ }
    setMarks([]);
    setTutor(null);
    setExamQ(null);
    setExamResult(null);
    setCompileError(null);
    setSelected(null);
  }

  async function compile(d: DictationResult) {
    if (!courseId) return;
    setBusy(true);
    setCompileError(null);
    try {
      const res = await fetch("/api/events/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: d.transcript,
          inputKind: d.provider === "typed" ? "typed" : "voice",
          confidence: d.confidence,
          latencyMs: d.latencyMs,
          transcriptionSessionId: d.sessionId ?? null,
          clientEventId: crypto.randomUUID(),
          courseId,
        }),
      });
      if (!res.ok) throw new Error("compile failed");
      const out = (await res.json()) as CompileOut;
      const cname = conceptsRef.current.find((c) => c.id === out.event.primaryConceptId)?.name ?? null;
      setMarks((m) => [{ event: out.event, concept: cname, delta: out.delta }, ...m].slice(0, 8));
      setTutor(out.tutor);
      setBoot((b) => (b ? { ...b, mastery: out.mastery, events: [...b.events, out.event] } : b));
      if (out.event.primaryConceptId) setSelected(out.event.primaryConceptId);
      logEvent("thought_mark_created");
      void refreshMemory();
      if (out.event.requestedAction === "quiz") {
        const q = await fetch("/api/exam/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conceptId: out.event.primaryConceptId, courseId }),
        }).then((r) => r.json());
        setExamQ(q);
        setExamResult(null);
        logEvent("exam_started");
      }
    } catch {
      setCompileError({
        message: "Couldn't compile that thought — the request failed. Nothing was recorded.",
        retry: () => void compile(d),
      });
    } finally {
      setBusy(false);
    }
  }

  async function answerExam(answer: string) {
    if (!examQ || !courseId) return;
    setBusy(true);
    setCompileError(null);
    try {
      const res = await fetch("/api/exam/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: examQ.id, answer, clientEventId: crypto.randomUUID(), courseId }),
      });
      if (!res.ok) throw new Error("exam answer failed");
      const d = await res.json();
      setTutor({ text: d.feedback, evidenceIds: d.evidenceIds, strategy: d.verdict });
      setExamResult({ verdict: d.verdict, correctPoints: d.correctPoints ?? [], missingPoints: d.missingPoints ?? [], possibleMisconception: d.possibleMisconception ?? null, feedback: d.feedback, evidenceIds: d.evidenceIds ?? [] });
      setBoot((b) => (b ? { ...b, mastery: d.mastery } : b));
      logEvent("exam_answered");
    } catch {
      setCompileError({ message: "Couldn't score that answer — the request failed. Your recording was not saved.", retry: () => void answerExam(answer) });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!courseId) return;
    setResetting(true);
    setBootError(null);
    try {
      const r = await fetch(`/api/learner?reset=1&courseId=${encodeURIComponent(courseId)}`);
      if (!r.ok) throw new Error("reset failed");
      const d = await r.json();
      const next: Boot = {
        mastery: d.mastery,
        events: Array.isArray(d.events) ? d.events : [],
        concepts: Array.isArray(d.concepts) ? d.concepts : [],
        productEvents: Array.isArray(d.productEvents) ? d.productEvents : [],
      };
      conceptsRef.current = next.concepts;
      setBoot(next);
      setPriors(d.priors ?? {});
      setSelected(weakestConceptId(next.concepts, next.mastery));
      setMarks([]);
      setTutor(null);
      setExamQ(null);
      setExamResult(null);
      setCompileError(null);
      void refreshMemory();
    } catch {
      setBootError("Reset didn't go through. Try again.");
    } finally {
      setResetting(false);
    }
  }

  const sel = selected && boot ? boot.mastery[selected] : null;
  const selConcept = boot?.concepts.find((c) => c.id === selected) ?? null;
  const activeCourse = courses.find((c) => c.id === courseId) ?? null;

  return (
    <MotionConfig reducedMotion="user">
      <Nav />
      <main id="main" className="mx-auto max-w-6xl px-5 py-8">
        <PageHeader
          eyebrow="{ study }"
          title={activeCourse ? `${activeCourse.code} — ${activeCourse.title}` : "Study"}
          description="Speak or type while you learn. Every thought becomes a Thought Mark; every mark moves the graph on the right."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {courses.length > 0 ? (
                <CoursePicker courses={courses} value={courseId ?? DEFAULT_COURSE_ID} onChange={changeCourse} />
              ) : null}
              <button
                type="button"
                className="btn-ghost !py-2 text-sm"
                onClick={reset}
                disabled={resetting}
                aria-busy={resetting}
              >
                {resetting ? "Resetting…" : "Reset demo"}
              </button>
            </div>
          }
        />

        <ol className="mono mt-4 grid gap-2 text-xs sm:grid-cols-2" style={{ color: "var(--color-ash)" }} aria-label="Golden path steps">
          {GOLDEN_STEPS.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-lg border hairline px-3 py-2">
              <span
                aria-hidden
                className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border hairline text-[10px]"
                style={{ color: "var(--color-cognition)" }}
              >
                {i + 1}
              </span>
              <span className="leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>

        {bootError ? (
          <div className="mt-4">
            <ErrorBanner message={bootError} onRetry={() => void (courseId && load(courseId))} retryLabel="Retry load" />
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[320px_minmax(0,1fr)_344px]">
          <div className="space-y-4 lg:col-start-1 lg:row-start-1 xl:col-start-2">
            <VoiceButton onResult={(d) => void compile(d)} busy={busy} />

            {compileError ? (
              <ErrorBanner message={compileError.message} onRetry={compileError.retry} retryLabel="Try again" />
            ) : null}

            {memory.length > 0 ? (
              <div className="flex flex-wrap gap-2" aria-label="VIVA memory">
                {memory.map((m) => (
                  <span key={m} className="chip" style={{ color: "var(--color-signal)" }}>
                    <span aria-hidden>◈</span> {m}
                  </span>
                ))}
              </div>
            ) : null}

            {busy ? <LoadingBlock label="Compiling thought — intent, evidence, mastery…" lines={2} /> : null}

            <TutorPanel text={tutor?.text ?? null} evidenceIds={tutor?.evidenceIds ?? []} strategy={tutor?.strategy} />

            {examQ ? (
              <section aria-label="VIVA oral exam" className="surface-card p-5">
                <p className="eyebrow">viva oral exam · practice assessment</p>
                <p className="heading mt-1 text-lg">{examQ.question}</p>
                <ExamAnswer onAnswer={answerExam} />
                {examResult ? (
                  <div className="mt-4 space-y-3">
                    {examResult.correctPoints.length > 0 ? <ResultBlock tone="correct">{examResult.correctPoints.join(" ")}</ResultBlock> : null}
                    {examResult.missingPoints.length > 0 ? <ResultBlock tone="missing">{examResult.missingPoints.join(" ")}</ResultBlock> : null}
                    {examResult.possibleMisconception ? <ResultBlock tone="misconception">{examResult.possibleMisconception}</ResultBlock> : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            <section aria-label="Thought Marks" className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="heading text-base">Thought Marks</h2>
                <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                  {marks.length > 0 ? `${marks.length} of last 8` : "empty"}
                </span>
              </div>
              {marks.length === 0 && !busy ? (
                <div
                  role="log"
                  aria-live="polite"
                  className="rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                  style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                >
                  No Thought Marks yet — hold <kbd className="mono rounded border hairline px-1.5 py-0.5 text-[11px]">Space</kbd> or type one above.
                  Try: “I don’t understand why attention needs positional encoding.”
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1" role="log" aria-live="polite">
                  {marks.map((m) => (
                    <ThoughtMark key={m.event.id} event={m.event} conceptName={m.concept} delta={m.delta} />
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="space-y-4 xl:sticky xl:top-20 xl:col-start-3 xl:row-start-1 xl:self-start lg:col-start-2 lg:row-start-1">
            {boot ? (
              <Graph mastery={boot.mastery} selected={selected} onSelect={setSelected} concepts={boot.concepts} />
            ) : bootLoading ? (
              <LoadingBlock label="Loading your misconception graph…" lines={5} />
            ) : null}

            {sel && selConcept ? (
              <section aria-label="Concept detail" className="surface-card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="heading text-base">{selConcept.name}</h3>
                  {priors[selConcept.id] !== undefined ? (
                    <span className="chip" title="This track starts from a labeled demo prior, not a measured result — your events move it from here.">
                      demo prior {Math.round(priors[selConcept.id] * 100)}%
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>{selConcept.description}</p>
                <dl className="mono mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs" style={{ color: "var(--color-ash)" }}>
                  <div>
                    <dt className="text-[10px] tracking-widest">MASTERY</dt>
                    <dd style={{ color: "var(--color-paper)" }}>{Math.round(sel.mastery * 100)}%</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-widest">REVIEW PRIORITY</dt>
                    <dd>{Math.round(sel.reviewPriority * 100)}%</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-widest">CONFUSIONS</dt>
                    <dd>{sel.confusionCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-widest">FAILED RECALLS</dt>
                    <dd>{sel.failedRecallCount}</dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </div>

          <div className="min-w-0 xl:col-start-1 xl:row-start-1">
            <SourceReader highlightIds={tutor?.evidenceIds ?? []} courseId={courseId ?? undefined} />
          </div>
        </div>
      </main>
    </MotionConfig>
  );
}

function ExamAnswer({ onAnswer }: { onAnswer: (a: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="mt-3 flex gap-2">
      <label htmlFor="exam-a" className="sr-only">Your spoken or typed answer</label>
      <input id="exam-a" value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) { onAnswer(v.trim()); setV(""); } }}
        placeholder="Answer aloud via mic above, or type here" className="w-full min-w-0 rounded-lg border hairline px-4 py-3 text-sm" style={{ background: "var(--color-panel)" }} />
      <button className="btn-ghost shrink-0 !py-2" onClick={() => { if (v.trim()) { onAnswer(v.trim()); setV(""); } }}>Answer</button>
    </div>
  );
}
