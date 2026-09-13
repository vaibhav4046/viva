"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { MicButton } from "@/components/voice/MicButton";
import { Graph } from "@/components/Graph";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { QuizQuestion, QuizVerdictPanel } from "@/components/QuizCard";
import {
  CoursePicker,
  DEFAULT_COURSE_ID,
  fetchCourses,
  readCourseParam,
  readStoredCourse,
  writeStoredCourse,
  type CourseMeta,
} from "@/components/course/CoursePicker";
import { rememberEvent, rememberMastery } from "@/components/mirror";
import { CONCEPTS } from "@/lib/course";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

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
/** What POST /api/exam/answer returns, of which this page reads a part. */
type ExamAnswerBody = Partial<Omit<ExamAssessment, "verdict">> & {
  verdict: ExamAssessment["verdict"];
  feedback: string;
  event: LearningEvent;
  mastery: Record<string, ConceptMastery>;
};
type TeachPrompt = { conceptId: string; conceptName: string; prompt: string; hint: string };
type TeachResult = {
  coverage: number; score: number; correctPoints: string[]; missingPoints: string[];
  feedback: string; event: LearningEvent; mastery: Record<string, ConceptMastery>;
  delta: number | null; reason: string | null;
};
type Failure = { message: string; retry: () => void };

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

  /** The mic reports its own phase; the chip only has three states to show. */
  const onPhase = useCallback((phase: "idle" | "listening" | "transcribing" | "review" | "thinking") => {
    setVoiceState(phase === "listening" ? "recording" : phase === "transcribing" || phase === "thinking" ? "working" : "idle");
  }, []);

  // Stable arrays: a fresh one every render would re-register the mic's
  // Space-key listeners on each pass.
  const examContext = useMemo(() => (q ? [q.question] : []), [q]);
  const teachContext = useMemo(() => (teach ? [teach.prompt] : []), [teach]);

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
    const clientEventId = crypto.randomUUID();
    try {
      const res = await fetch("/api/exam/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id, answer: transcript, clientEventId, courseId }),
      });
      if (!res.ok) throw new Error("exam answer failed");
      const d = (await res.json()) as ExamAnswerBody;
      setResult({
        verdict: d.verdict, correctPoints: d.correctPoints ?? [], missingPoints: d.missingPoints ?? [],
        possibleMisconception: d.possibleMisconception ?? null, feedback: d.feedback,
        evidenceIds: d.evidenceIds ?? [], delta: d.delta ?? null, reason: d.reason ?? null,
      });
      setMastery(d.mastery);
      // Written down here as well as on whichever instance graded it, carrying
      // the id the replay dedupes on — the same two lines /study has. Without
      // them a quiz answer is not in the browser's record, so when the server
      // copy shrinks there is nothing to defend it with and the recall the
      // student watched register goes back to "Not yet".
      rememberEvent(d.event, clientEventId);
      rememberMastery(d.mastery);
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
    const clientEventId = crypto.randomUUID();
    try {
      const res = await fetch("/api/teachback/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId: teach.conceptId, transcript, clientEventId, courseId }),
      });
      if (!res.ok) throw new Error("teachback answer failed");
      const d = (await res.json()) as TeachResult;
      setTeachFb(d);
      setMastery(d.mastery);
      rememberEvent(d.event, clientEventId);
      rememberMastery(d.mastery);
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
        {!focused ? (
          <>
            <PageHeader
              title={activeCourse ? `${activeCourse.title} quiz` : "Quiz"}
              description="Answer out loud, or type. Every verdict quotes the passage it was scored against."
              actions={
                courses.length > 0 ? (
                  <CoursePicker courses={courses} value={courseId ?? DEFAULT_COURSE_ID} onChange={changeCourse} label="Subject" />
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
                  className={mode === m ? "btn-ghost !px-4 !py-1.5 text-sm" : "btn-ghost !border-transparent !px-4 !py-1.5 text-sm"}
                  /* fontWeight is inline, not `font-semibold`: globals.css is
                     authored outside Tailwind's layers, so .btn-ghost's
                     font-weight:500 beat the utility and the weight never
                     rendered. An inline style beats the unlayered class. */
                  style={mode === m ? { background: "var(--color-panel)", color: "var(--color-paper)", fontWeight: 600 } : undefined}
                >
                  {m === "exam" ? "Answer questions" : "Teach VIVA"}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">{`${activeCourse?.code ?? "VIVA"} · Focused practice`}</p>
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
              <div className="mt-6 grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
                <section className="surface-card p-6">
                  <h2 className="heading text-xl">Answer under exam conditions</h2>
                  <ul className="mt-4 space-y-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono shrink-0" style={{ color: "var(--color-ash)" }}>01</span>
                      Questions from this subject, weakest concept first.
                    </li>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono shrink-0" style={{ color: "var(--color-ash)" }}>02</span>
                      Every verdict quotes the passage it was scored against.
                    </li>
                    <li className="flex gap-3">
                      <span aria-hidden className="mono shrink-0" style={{ color: "var(--color-ash)" }}>03</span>
                      Scored on what you covered, not on how you worded it.
                    </li>
                  </ul>
                  {/*
                    * One door, and it is the one with the label on it.
                    *
                    * This screen used to carry a whole mic — waveform, language
                    * picker, typed box — above a ghost "Start the quiz" pill 325
                    * px below it. The filled lime button was therefore the
                    * loudest thing on a page that has not asked a question yet,
                    * and it was also a lie: its onSubmit threw the transcript
                    * away and called start(). A student held to talk, spoke,
                    * waited for the words to come back and watched them
                    * disappear into a question they had not been asked.
                    *
                    * The mic belongs to the question, so it now arrives with
                    * one. Paper pill rather than lime, because lime belongs to
                    * the mic — the same rule /today and the landing hero keep.
                    */}
                  <div className="mt-6">
                    <button onClick={start} disabled={busy === "start"} className="btn-primary">
                      {busy === "start" ? "Preparing question…" : "Start the quiz"}
                    </button>
                  </div>
                  <p className="mono mt-3 text-xs" style={{ color: "var(--color-ash)" }}>
                    The mic comes up with the question. Typing works just as well.
                  </p>
                  {busy === "start" ? <div className="mt-4"><LoadingBlock label="Selecting your weakest concept…" lines={2} /></div> : null}
                </section>
                <div className="space-y-4">
                  {mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Opening your map…" lines={5} /> : null}
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                  <QuizQuestion
                    large
                    eyebrow={`Question${conceptName ? ` · ${conceptName}` : ""}`}
                    question={q.question}
                    status={result ? <span className="chip">Marked</span> : <VoiceStateChip state={voiceState} scoring={busy === "answer"} />}
                  />

                  {result ? (
                    <QuizVerdictPanel
                      result={result}
                      actions={
                        <>
                          <button onClick={() => void start()} disabled={busy !== null} className="btn-lime !py-2 text-sm">
                            {busy === "start" ? "Preparing…" : "Next question →"}
                          </button>
                          <button onClick={() => setResult(null)} className="btn-ghost !py-2 text-sm">
                            Answer this one again
                          </button>
                        </>
                      }
                    />
                  ) : (
                    <>
                      <MicButton
                        subjectId={courseId ?? DEFAULT_COURSE_ID}
                        onSubmit={(t) => void answer(t.text)}
                        onPhaseChange={onPhase}
                        busy={busy === "answer"}
                        context={examContext}
                      />
                      {busy === "answer" ? <LoadingBlock label="Scoring your answer against the source…" lines={2} /> : null}
                    </>
                  )}
                </div>
                <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Opening your map…" lines={5} /> : null}</div>
              </div>
            )
          ) : !teach ? (
            <div className="mt-6 grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
              <section className="surface-card p-6">
                <h2 className="heading text-xl">Teach it back</h2>
                <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                  VIVA picks your weakest concept and listens while you teach it back.
                  Coverage is scored against your source, not against your wording.
                </p>
                {/* Same defect as the quiz panel above, same fix. */}
                <div className="mt-6">
                  <button onClick={startTeach} disabled={busy === "teach"} className="btn-primary">
                    {busy === "teach" ? "Preparing prompt…" : "Teach VIVA"}
                  </button>
                </div>
                <p className="mono mt-3 text-xs" style={{ color: "var(--color-ash)" }}>
                  The mic comes up with the concept. Typing works just as well.
                </p>
                {busy === "teach" ? <div className="mt-4"><LoadingBlock label="Choosing the concept you know least well…" lines={2} /></div> : null}
              </section>
              <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Opening your map…" lines={5} /> : null}</div>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-4">
                <section className="surface-card p-6" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="eyebrow">Teach it back · {teach.conceptName}</p>
                    {teachFb ? (
                      <span className="chip">Marked</span>
                    ) : (
                      <VoiceStateChip state={voiceState} scoring={busy === "answer"} />
                    )}
                  </div>
                  <p className="heading mt-2 text-[clamp(1.35rem,3.2vw,2rem)] leading-tight">{teach.prompt}</p>
                </section>

                {teachFb ? (
                  <section aria-label="Teach it back result" aria-live="polite" className="surface-card p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h2 className="heading text-base">Coverage</h2>
                      <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                        {teachFb.reason ?? ""}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="meter flex-1" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={teachFb.score} aria-label="How much you covered">
                        <span style={{ transform: `scaleX(${teachFb.coverage})` }} />
                      </div>
                      <span className="mono text-xs" style={{ color: "var(--color-cognition)" }}>{teachFb.score}%</span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>{teachFb.feedback}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {teachFb.correctPoints.map((p) => (
                        <span key={p} className="chip" style={{ color: "var(--color-band-solid)", borderColor: "var(--color-band-solid)" }}>
                          <span aria-hidden>✓</span> {p}
                        </span>
                      ))}
                      {teachFb.missingPoints.map((p) => (
                        <span key={p} className="chip" style={{ color: "var(--color-band-getting)" }}>
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
                    <MicButton
                      subjectId={courseId ?? DEFAULT_COURSE_ID}
                      onSubmit={(t) => void answerTeach(t.text)}
                      onPhaseChange={onPhase}
                      busy={busy === "answer"}
                      context={teachContext}
                    />
                    <p className="text-sm" style={{ color: "var(--color-ash)" }}>Hint: {teach.hint}</p>
                    {busy === "answer" ? <LoadingBlock label="Scoring coverage against the source…" lines={2} /> : null}
                  </>
                )}
              </div>
              <div>{mastery ? <Graph mastery={mastery} concepts={graphConcepts} /> : masteryLoading ? <LoadingBlock label="Opening your map…" lines={5} /> : null}</div>
            </div>
          )}
        </div>
    </MotionConfig>
  );
}

function VoiceStateChip({ state, scoring }: { state: VoiceState; scoring: boolean }) {
  // Periwinkle is the "Getting there" band and nothing else. Transcribing and
  // scoring are machine states, so they take the chip's own ash; only
  // "listening" keeps lime, because lime belongs to the mic.
  if (scoring) {
    return (
      <span className="chip">
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
      <span className="chip">
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
