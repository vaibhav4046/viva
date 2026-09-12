"use client";
import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import { Nav } from "@/components/Nav";
import { VoiceButton } from "@/components/VoiceButton";
import { Graph } from "@/components/Graph";
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
import { CONCEPTS } from "@/lib/course";
import type { ConceptMastery } from "@/lib/types";

type Mode = "exam" | "teach";
type VoiceState = "idle" | "recording" | "working";

type Question = { id: string; conceptId: string; question: string };
type ExamAssessment = {
  verdict: "correct" | "partial" | "incorrect";
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
  delta: number | null;
  reason: string | null;
};
type TeachPrompt = { conceptId: string; conceptName: string; prompt: string; hint: string };
type TeachResult = {
  coverage: number; score: number; correctPoints: string[]; missingPoints: string[];
  feedback: string; mastery: Record<string, ConceptMastery>;
  delta: number | null; reason: string | null;
};
type Failure = { message: string; retry: () => void };

const VERDICT_CHIP: Record<string, { color: string; label: string }> = {
  correct: { color: "var(--color-cognition)", label: "CORRECT" },
  partial: { color: "var(--color-signal)", label: "PARTIAL" },
  incorrect: { color: "var(--color-coral)", label: "MISCONCEPTION" },
};

export default function ExamPage() {
  const [mode, setMode] = useState<Mode>("exam");
  const [q, setQ] = useState<Question | null>(null);
  const [result, setResult] = useState<ExamAssessment | null>(null);
  const [mastery, setMastery] = useState<Record<string, ConceptMastery> | null>(null);
  const [masteryLoading, setMasteryLoading] = useState(true);
  const [teach, setTeach] = useState<TeachPrompt | null>(null);
  const [teachFb, setTeachFb] = useState<TeachResult | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [busy, setBusy] = useState<null | "start" | "answer" | "teach">(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  const [concepts, setConcepts] = useState<{ id: string; name: string }[]>([]);
  const [courseId, setCourseId] = useState<string | null>(null);

  const focused = (mode === "exam" && q !== null) || (mode === "teach" && teach !== null);

  useEffect(() => {
    document.body.dataset.examFocus = focused ? "true" : "false";
    return () => { delete document.body.dataset.examFocus; };
  }, [focused]);

  // Resolve course once on the client: ?course → stored → default. ?mode=teach
  // is the deep link Today's teachback segments use.
  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then(setCourses)
        .catch(() => setCourses([]));
      try {
        const sp = new URLSearchParams(window.location.search);
        if (sp.get("mode") === "teach") setMode("teach");
      } catch { /* prerender — no window */ }
      setCourseId(readCourseParam() || readStoredCourse() || DEFAULT_COURSE_ID);
    })();
  }, []);

  useEffect(() => {
    if (!courseId) return;
    let alive = true;
    (async () => {
      setMasteryLoading(true);
      try {
        const r = await fetch(`/api/learner?courseId=${encodeURIComponent(courseId)}`);
        if (!r.ok) throw new Error("learner failed");
        const l = await r.json();
        if (!alive) return;
        setMastery(l.mastery);
        setConcepts(Array.isArray(l.concepts) ? l.concepts.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })) : []);
      } catch { /* graph is optional before the first question */ }
      finally { if (alive) setMasteryLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  function changeCourse(id: string) {
    if (!id || id === courseId) return;
    writeStoredCourse(id);
    setCourseId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("course", id);
      window.history.replaceState(null, "", url.toString());
    } catch { /* no window (prerender) */ }
    exitFocus();
  }

  async function start() {
    if (!courseId) return;
    setBusy("start");
    setFailure(null);
    try {
      const res = await fetch("/api/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId }),
      });
      if (!res.ok) throw new Error("exam start failed");
      const d = (await res.json()) as Question;
      setQ(d);
      setResult(null);
      setVoiceState("idle");
    } catch {
      setFailure({ message: "Couldn't load a question — the exam service didn't respond.", retry: () => void start() });
    } finally {
      setBusy(null);
    }
  }

  async function answer(transcript: string) {
    if (!q || !courseId) return;
    setBusy("answer");
    setFailure(null);
    try {
      const res = await fetch("/api/exam/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id, answer: transcript, clientEventId: crypto.randomUUID(), courseId }),
      });
      if (!res.ok) throw new Error("exam answer failed");
      const d = await res.json();
      setResult({
        verdict: d.verdict, correctPoints: d.correctPoints ?? [], missingPoints: d.missingPoints ?? [],
        possibleMisconception: d.possibleMisconception ?? null, feedback: d.feedback,
        evidenceIds: d.evidenceIds ?? [], delta: d.delta ?? null, reason: d.reason ?? null,
      });
      setMastery(d.mastery);
    } catch {
      setFailure({ message: "Couldn't score that answer — it may not have been recorded.", retry: () => void answer(transcript) });
    } finally {
      setBusy(null);
    }
  }

  async function startTeach() {
    if (!courseId) return;
    setBusy("teach");
    setFailure(null);
    try {
      const res = await fetch("/api/teachback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId }),
      });
      if (!res.ok) throw new Error("teach start failed");
      const d = (await res.json()) as TeachPrompt;
      setTeach(d);
      setTeachFb(null);
      setVoiceState("idle");
    } catch {
      setFailure({ message: "Couldn't load a teachback concept.", retry: () => void startTeach() });
    } finally {
      setBusy(null);
    }
  }

  async function answerTeach(transcript: string) {
    if (!teach || !courseId) return;
    setBusy("answer");
    setFailure(null);
    try {
      const res = await fetch("/api/teachback/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId: teach.conceptId, transcript, clientEventId: crypto.randomUUID(), courseId }),
      });
      if (!res.ok) throw new Error("teachback answer failed");
      const d = (await res.json()) as TeachResult;
      setTeachFb(d);
      setMastery(d.mastery);
    } catch {
      setFailure({ message: "Couldn't score that explanation — it may not have been recorded.", retry: () => void answerTeach(transcript) });
    } finally {
      setBusy(null);
    }
  }

  function exitFocus() {
    setQ(null);
    setResult(null);
    setTeach(null);
    setTeachFb(null);
    setFailure(null);
    setVoiceState("idle");
  }

  const conceptName = q
    ? concepts.find((c) => c.id === q.conceptId)?.name ?? CONCEPTS.find((c) => c.id === q.conceptId)?.name ?? null
    : null;
  const graphConcepts = concepts.length > 0 ? concepts : undefined;
  const activeCourse = courses.find((c) => c.id === courseId) ?? null;

  return (
    <MotionConfig reducedMotion="user">
      <Nav />
      <main id="main" className={focused ? "mx-auto max-w-6xl px-5 py-6" : "mx-auto max-w-6xl px-5 py-8"}>
        {!focused ? (
          <>
            <PageHeader
              eyebrow="viva oral exam · practice assessment"
              title={activeCourse ? `${activeCourse.code} Oral Examination` : "Oral Examination"}
              description="Practice only. Answer aloud or type — every verdict is scored against the course source, and mastery moves only from your own words."
              actions={
                courses.length > 0 ? (
                  <CoursePicker courses={courses} value={courseId ?? DEFAULT_COURSE_ID} onChange={changeCourse} />
                ) : undefined
              }
            />
            <div
              role="tablist"
              aria-label="Practice mode"
              className="mt-4 inline-flex gap-1 rounded-full border hairline p-1"
              style={{ background: "var(--color-graphite)" }}
            >
              {(["exam", "teach"] as Mode[]).map((m) => (
                <button
                  key={m}
                  role="tab"
                  id={`tab-${m}`}
                  aria-selected={mode === m}
                  aria-controls="exam-panel"
                  onClick={() => { setMode(m); setFailure(null); }}
                  className={mode === m ? "btn-lime !px-4 !py-1.5 text-sm" : "btn-ghost !border-transparent !px-4 !py-1.5 text-sm"}
                >
                  {m === "exam" ? "Answer questions" : "Teach VIVA"}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">{`{ ${activeCourse?.code ?? "VIVA"} · focused practice }`}</p>
            <button type="button" onClick={exitFocus} className="btn-ghost !px-4 !py-1.5 text-xs">
              Exit focus
            </button>
          </div>
        )}

        {failure ? (
          <div className="mt-4">
            <ErrorBanner message={failure.message} onRetry={failure.retry} retryLabel="Try again" />
          </div>
        ) : null}

        <div
          id="exam-panel"
          role={focused ? undefined : "tabpanel"}
          aria-labelledby={focused ? undefined : `tab-${mode}`}
          aria-label={focused ? "Focused practice" : undefined}
        >
          {mode === "exam" ? (
            !q ? (
              <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <section className="surface-card p-6">
                  <h2 className="heading text-xl">Answer under exam conditions</h2>
                  <ul className="mt-4 space-y-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono" style={{ color: "var(--color-cognition)" }}>01</span>
                      Questions across the selected lab — weakest concept first.
                    </li>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono" style={{ color: "var(--color-cognition)" }}>02</span>
                      Every verdict cites the course chunks it was scored against.
                    </li>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono" style={{ color: "var(--color-cognition)" }}>03</span>
                      No model grades you: keyword coverage is deterministic and replayable.
                    </li>
                  </ul>
                  <button onClick={start} disabled={busy === "start"} className="btn-lime mt-6">
                    {busy === "start" ? "Preparing question…" : "Enter VIVA"}
                  </button>
                  {busy === "start" ? <div className="mt-4"><LoadingBlock label="Selecting your weakest concept…" lines={2} /></div> : null}
                </section>
                <div className="space-y-4">
                  {mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Loading your misconception graph…" lines={5} /> : null}
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                  <section className="surface-card p-6" aria-live="polite">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="eyebrow">QUESTION{conceptName ? ` · ${conceptName}` : ""}</p>
                      {result ? (
                        <span className="chip">assessed</span>
                      ) : (
                        <VoiceStateChip state={voiceState} scoring={busy === "answer"} />
                      )}
                    </div>
                    <p className="heading mt-2 text-[clamp(1.35rem,3.2vw,2rem)] leading-tight">{q.question}</p>
                  </section>

                  {result ? (
                    <section aria-label="Assessment" aria-live="polite" className="surface-card space-y-3 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="chip" style={{ color: VERDICT_CHIP[result.verdict].color, borderColor: VERDICT_CHIP[result.verdict].color }}>
                          {VERDICT_CHIP[result.verdict].label}
                        </span>
                        <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                          {typeof result.delta === "number" ? `mastery ${result.delta > 0 ? "+" : ""}${Math.round(result.delta * 100)} pts` : ""}
                          {result.evidenceIds.length > 0 ? ` · evidence ${result.evidenceIds.length} chunks` : ""}
                        </span>
                      </div>
                      {result.correctPoints.length > 0 ? <ResultBlock tone="correct">{result.correctPoints.join(" ")}</ResultBlock> : null}
                      {result.missingPoints.length > 0 ? <ResultBlock tone="missing">{result.missingPoints.join(" ")}</ResultBlock> : null}
                      {result.possibleMisconception ? <ResultBlock tone="misconception">{result.possibleMisconception}</ResultBlock> : null}
                      <ResultBlock tone="next">
                        {result.feedback}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button onClick={() => void start()} disabled={busy !== null} className="btn-lime !py-2 text-sm">
                            {busy === "start" ? "Preparing…" : "Next question →"}
                          </button>
                          <button onClick={() => setResult(null)} className="btn-ghost !py-2 text-sm">
                            Answer this one again
                          </button>
                        </div>
                      </ResultBlock>
                    </section>
                  ) : (
                    <>
                      <VoiceButton onResult={(d) => void answer(d.transcript)} onState={setVoiceState} busy={busy === "answer"} label="Answer aloud — or type below" />
                      {busy === "answer" ? <LoadingBlock label="Scoring your answer against the source…" lines={2} /> : null}
                    </>
                  )}
                </div>
                <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Loading your misconception graph…" lines={5} /> : null}</div>
              </div>
            )
          ) : !teach ? (
            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <section className="surface-card p-6">
                <h2 className="heading text-xl">Teach it back</h2>
                <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                  VIVA picks your weakest concept and listens while you teach it back.
                  Coverage is scored against the source — no model grades you.
                </p>
                <button onClick={startTeach} disabled={busy === "teach"} className="btn-lime mt-6">
                  {busy === "teach" ? "Preparing prompt…" : "Teach VIVA"}
                </button>
                {busy === "teach" ? <div className="mt-4"><LoadingBlock label="Choosing the concept you know least well…" lines={2} /></div> : null}
              </section>
              <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Loading your misconception graph…" lines={5} /> : null}</div>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-4">
                <section className="surface-card p-6" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="eyebrow">teach back · {teach.conceptName}</p>
                    {teachFb ? (
                      <span className="chip">assessed</span>
                    ) : (
                      <VoiceStateChip state={voiceState} scoring={busy === "answer"} />
                    )}
                  </div>
                  <p className="heading mt-2 text-[clamp(1.35rem,3.2vw,2rem)] leading-tight">{teach.prompt}</p>
                </section>

                {teachFb ? (
                  <section aria-label="Teachback result" aria-live="polite" className="surface-card p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h2 className="heading text-base">Coverage</h2>
                      <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                        {typeof teachFb.delta === "number" ? `${teachFb.delta > 0 ? "+" : ""}${Math.round(teachFb.delta * 100)} pts · ` : ""}{teachFb.reason ?? ""}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="meter meter-spectrum flex-1" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={teachFb.score} aria-label="Teachback coverage score">
                        <span style={{ transform: `scaleX(${teachFb.coverage})` }} />
                      </div>
                      <span className="mono text-xs" style={{ color: "var(--color-cognition)" }}>{teachFb.score}%</span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>{teachFb.feedback}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {teachFb.correctPoints.map((p) => (
                        <span key={p} className="chip" style={{ color: "var(--color-cognition)", borderColor: "var(--color-cognition)" }}>
                          <span aria-hidden>✓</span> {p}
                        </span>
                      ))}
                      {teachFb.missingPoints.map((p) => (
                        <span key={p} className="chip" style={{ color: "var(--color-signal)" }}>
                          <span aria-hidden>→</span> {p}
                        </span>
                      ))}
                    </div>
                    <div className="mt-4">
                      <button onClick={startTeach} disabled={busy !== null} className="btn-ghost !py-2 text-sm">
                        Try again — 45 seconds
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    <VoiceButton onResult={(d) => void answerTeach(d.transcript)} onState={setVoiceState} busy={busy === "answer"} label="Explain aloud — or type below" />
                    <p className="text-sm" style={{ color: "var(--color-ash)" }}>Hint: {teach.hint}</p>
                    {busy === "answer" ? <LoadingBlock label="Scoring coverage against the source…" lines={2} /> : null}
                  </>
                )}
              </div>
              <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Loading your misconception graph…" lines={5} /> : null}</div>
            </div>
          )}
        </div>
      </main>
    </MotionConfig>
  );
}

function VoiceStateChip({ state, scoring }: { state: VoiceState; scoring: boolean }) {
  if (scoring) {
    return (
      <span className="chip" style={{ color: "var(--color-signal)" }}>
        <span aria-hidden>◐</span> scoring
      </span>
    );
  }
  if (state === "recording") {
    return (
      <span className="chip" style={{ color: "var(--color-cognition)" }}>
        <span aria-hidden>●</span> listening
      </span>
    );
  }
  if (state === "working") {
    return (
      <span className="chip" style={{ color: "var(--color-signal)" }}>
        <span aria-hidden>◐</span> transcribing
      </span>
    );
  }
  return (
    <span className="chip">
      <span aria-hidden>○</span> awaiting answer
    </span>
  );
}
