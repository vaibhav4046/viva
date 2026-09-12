"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { MicButton, type TypedHandle, type VoiceTurn } from "@/components/voice/MicButton";
import { Note } from "@/components/Note";
import { Graph } from "@/components/Graph";
import { SourceReader } from "@/components/SourceReader";
import { TutorPanel } from "@/components/TutorPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ResultBlock } from "@/components/ui/ResultBlock";
import { announceSaved } from "@/components/AppShell";
import { BAND_COLOR, BAND_LABEL, BAND_ORDER, bandFor, type BandKey } from "@/components/bands";
import {
  CoursePicker,
  DEFAULT_COURSE_ID,
  fetchCourses,
  readCourseParam,
  readStoredCourse,
  writeStoredCourse,
  type CourseMeta,
} from "@/components/course/CoursePicker";
import { rise } from "@/lib/motion";
import type { ConceptMastery, LearningEvent } from "@/lib/types";
import { logEvent } from "@/lib/analytics";

/*
 * /study — the product screen.
 *
 * Everything a judge needs is above the fold at 390 px: the subject, how it
 * is going, three things they could say, and the mic. The source passages and
 * the map sit below on a phone and beside on a laptop, because neither is
 * something you act on first.
 *
 * The four numbered script cards that used to sit on top of this page are
 * gone. They read as a test plan; the three "Try saying…" chips do the same
 * job by filling the typed box with a real sentence.
 */

type Assessment = {
  verdict: "correct" | "partial" | "incorrect";
  correctPoints: string[];
  missingPoints: string[];
  possibleMisconception: string | null;
  feedback: string;
  evidenceIds: string[];
  /** The question this answer was graded against. */
  question: string | null;
};

type TurnOut = {
  event: LearningEvent;
  tutor: { text: string; evidenceIds: string[]; strategy: string };
  mastery: Record<string, ConceptMastery>;
  delta: number | null;
  reason: string | null;
  /** Present only when the learner just answered an open question. */
  assessment: Assessment | null;
  turn: {
    id: string;
    intent: string;
    tutor: { question: string | null };
  };
};

type ConceptLite = { id: string; name: string; description: string };

type Boot = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: ConceptLite[];
};

const TRY_SAYING = [
  "I don't understand why attention needs positional encoding.",
  "Explain it without jargon.",
  "Quiz me on it.",
];

/** Lowest-scoring concept first, so the detail panel opens somewhere useful. */
function weakestConceptId(concepts: ConceptLite[], mastery: Record<string, ConceptMastery>): string | null {
  const ranked = concepts
    .filter((c) => mastery[c.id])
    .sort((a, b) => mastery[a.id].mastery - mastery[b.id].mastery || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? concepts[0]?.id ?? null;
}

export default function StudyPage() {
  const reduced = useReducedMotion() ?? false;
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ event: LearningEvent; concept: string | null; delta: number | null }[]>([]);
  const [tutor, setTutor] = useState<{ text: string; evidenceIds: string[]; strategy: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnError, setTurnError] = useState<{ message: string; retry: () => void } | null>(null);
  const [quiz, setQuiz] = useState<{ id: string; question: string } | null>(null);
  const [result, setResult] = useState<Assessment | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  const [courseId, setCourseId] = useState<string | null>(null);
  const conceptsRef = useRef<ConceptLite[]>([]);
  const typedRef = useRef<TypedHandle>(null);

  // Resolve the subject once on the client (?subject → ?course → stored → default).
  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then(setCourses)
        .catch(() => setCourses([]));
      let fromUrl: string | null = null;
      try {
        fromUrl = new URLSearchParams(window.location.search).get("subject");
      } catch {
        /* no window (prerender) */
      }
      setCourseId(fromUrl || readCourseParam() || readStoredCourse() || DEFAULT_COURSE_ID);
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
      };
      conceptsRef.current = next.concepts;
      setBoot(next);
      setSelected((prev) =>
        prev && next.concepts.some((c) => c.id === prev) ? prev : weakestConceptId(next.concepts, next.mastery)
      );
    } catch {
      setBootError("Couldn't open this subject. The server may still be waking up.");
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    if (courseId) void load(courseId);
  }, [courseId, load]);

  function changeSubject(id: string) {
    if (!id || id === courseId) return;
    writeStoredCourse(id);
    setCourseId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("subject", id);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* no window (prerender) */
    }
    setNotes([]);
    setTutor(null);
    setQuiz(null);
    setResult(null);
    setTurnError(null);
    setSelected(null);
  }

  /**
   * One conversational turn — the single entry point for anything the student
   * says or types.
   *
   * `/api/study/turn` owns the whole loop now: it reads the words, retrieves
   * passages and answers Socratically, and when a question from an earlier
   * turn is still open it grades the answer instead and hands back
   * `assessment`. The old build made a second round trip to start and mark a
   * quiz, which is how spoken answers used to land as notes and leave the
   * question hanging.
   */
  const takeTurn = useCallback(
    async (t: VoiceTurn) => {
      if (!courseId) return;
      setBusy(true);
      setTurnError(null);
      try {
        const res = await fetch("/api/study/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: t.text,
            subjectId: courseId,
            // Words a system dictation tool pasted in still arrived through
            // the typed box, so they are typed as far as the turn is concerned.
            origin: t.origin === "voice" ? "voice" : "typed",
            asr:
              t.origin === "voice"
                ? {
                    mode: t.asrMode === "dictation" || t.asrMode === "sync" ? t.asrMode : null,
                    confidence: t.confidence,
                    requestTimeMs: t.requestTimeMs,
                    audioMs: t.audioMs,
                    sessionId: t.sessionId,
                    clean: t.clean,
                  }
                : undefined,
            clientEventId: crypto.randomUUID(),
          }),
        });
        if (!res.ok) throw new Error("turn failed");
        const out = (await res.json()) as TurnOut;
        const cname = conceptsRef.current.find((c) => c.id === out.event.primaryConceptId)?.name ?? null;
        setNotes((m) => [{ event: out.event, concept: cname, delta: out.delta }, ...m].slice(0, 8));
        setTutor({ ...out.tutor, strategy: out.assessment?.verdict ?? out.tutor.strategy });
        setBoot((b) => (b ? { ...b, mastery: out.mastery, events: [...b.events, out.event] } : b));
        if (out.event.primaryConceptId) setSelected(out.event.primaryConceptId);
        announceSaved();
        logEvent("thought_mark_created");

        if (out.turn.intent === "quiz" && out.turn.tutor.question) {
          setQuiz({ id: out.turn.id, question: out.turn.tutor.question });
          setResult(null);
          logEvent("exam_started");
        } else if (out.assessment) {
          setResult(out.assessment);
          logEvent("exam_answered");
        } else {
          // Not a quiz and not an answer: the question, if there was one, is
          // behind us.
          setQuiz(null);
          setResult(null);
        }
      } catch {
        setTurnError({
          message: "That didn't reach VIVA. Nothing was saved — try again.",
          retry: () => void takeTurn(t),
        });
      } finally {
        setBusy(false);
      }
    },
    [courseId]
  );

  /** Recent turns, oldest first — recognition context for the next clip. */
  const spokenContext = useMemo(
    () => [...notes].reverse().map((n) => n.event.cleanedTranscript),
    [notes]
  );

  const bandCounts = boot
    ? BAND_ORDER.map((key) => ({
        key,
        count: boot.concepts.filter((c) => bandFor(boot.mastery[c.id]?.mastery, Boolean(boot.mastery[c.id])) === key).length,
      })).filter((b) => b.count > 0)
    : [];

  const subject = courses.find((c) => c.id === courseId) ?? null;
  const selConcept = boot?.concepts.find((c) => c.id === selected) ?? null;
  const selMastery = selected && boot ? boot.mastery[selected] : null;

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
      <PageHeader
        title={subject ? subject.title : "Study"}
        description="Say what you think. VIVA answers from your source and asks the one question that moves you."
        actions={
          courses.length > 0 ? (
            <CoursePicker courses={courses} value={courseId ?? DEFAULT_COURSE_ID} onChange={changeSubject} label="Subject" />
          ) : undefined
        }
      />

      {bandCounts.length > 0 ? (
        <ul className="mt-3 flex flex-wrap items-center gap-2" aria-label="How this subject is going">
          {bandCounts.map(({ key, count }) => (
            <li key={key} className="chip" style={{ color: BAND_COLOR[key as BandKey] }}>
              <span className="tnum">{count}</span> {BAND_LABEL[key as BandKey]}
            </li>
          ))}
        </ul>
      ) : null}

      {bootError ? (
        <div className="mt-4">
          <ErrorBanner message={bootError} onRetry={() => void (courseId && load(courseId))} retryLabel="Try again" />
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,34%)_minmax(0,1fr)_320px]">
        {/* Source: last on a phone, first on a wide screen. */}
        <div className="order-3 min-w-0 xl:order-1 xl:col-start-1 xl:row-start-1">
          <SourceReader highlightIds={tutor?.evidenceIds ?? []} courseId={courseId ?? undefined} />
        </div>

        {/* The conversation. First thing on every screen size. */}
        <div className="order-1 min-w-0 space-y-4 xl:order-2 xl:col-start-2 xl:row-start-1">
          <div className="flex flex-wrap gap-2">
            <span className="mono self-center text-xs" style={{ color: "var(--color-ash)" }}>
              Try saying
            </span>
            {TRY_SAYING.map((phrase) => (
              <button
                key={phrase}
                type="button"
                className="chip min-h-11 text-left hover:border-[var(--color-cognition)]"
                style={{ color: "var(--color-mist)" }}
                onClick={() => typedRef.current?.prefill(phrase)}
              >
                {phrase}
              </button>
            ))}
          </div>

          {/* Mic and typed box in one: rendering a second typed box here would
              duplicate id="viva-type". */}
          <MicButton
            subjectId={courseId ?? DEFAULT_COURSE_ID}
            onSubmit={takeTurn}
            busy={busy}
            context={spokenContext}
            typedHandleRef={typedRef}
          />

          {turnError ? <ErrorBanner message={turnError.message} onRetry={turnError.retry} retryLabel="Try again" /> : null}
          {busy ? <LoadingBlock label="Thinking…" lines={2} /> : null}

          <TutorPanel text={tutor?.text ?? null} evidenceIds={tutor?.evidenceIds ?? []} strategy={tutor?.strategy} />

          <AnimatePresence initial={false}>
            {quiz ? (
              <m.section key={quiz.id} aria-label="Quiz question" className="surface-card p-5" {...rise(reduced)}>
                <p className="eyebrow">Quiz</p>
                <p className="heading mt-1 text-lg">{quiz.question}</p>
                <p className="mt-2 text-sm" style={{ color: "var(--color-ash)" }}>
                  Answer out loud with the mic above, or type it.
                </p>
                {result ? (
                  <div className="mt-4 space-y-3">
                    {result.correctPoints.length > 0 ? <ResultBlock tone="correct">{result.correctPoints.join(" ")}</ResultBlock> : null}
                    {result.missingPoints.length > 0 ? <ResultBlock tone="missing">{result.missingPoints.join(" ")}</ResultBlock> : null}
                    {result.possibleMisconception ? <ResultBlock tone="misconception">{result.possibleMisconception}</ResultBlock> : null}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button type="button" className="btn-ghost !py-2 text-sm" onClick={() => { setQuiz(null); setResult(null); }}>
                        Back to talking
                      </button>
                    </div>
                  </div>
                ) : null}
              </m.section>
            ) : null}
          </AnimatePresence>

          <section aria-label="Your notes" className="space-y-3">
            <h2 className="heading text-base">Your notes</h2>
            {notes.length === 0 && !busy ? (
              <p
                role="log"
                aria-live="polite"
                className="rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
              >
                Nothing yet. Hold <kbd className="mono rounded border hairline px-1.5 py-0.5 text-xs">Space</kbd> and say what
                you think — or tap one of the lines above.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1" role="log" aria-live="polite">
                {notes.map((n) => (
                  <Note key={n.event.id} event={n.event} conceptName={n.concept} delta={n.delta} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* The map. Rail on a wide screen, a card under the conversation on a phone. */}
        <div className="order-2 min-w-0 space-y-4 xl:order-3 xl:col-start-3 xl:row-start-1 xl:sticky xl:top-20 xl:self-start">
          {boot ? (
            <Graph mastery={boot.mastery} selected={selected} onSelect={setSelected} concepts={boot.concepts} />
          ) : bootLoading ? (
            <LoadingBlock label="Opening your map…" lines={5} />
          ) : null}

          {selConcept && selMastery ? (
            <section aria-label="Concept detail" className="surface-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="heading text-base">{selConcept.name}</h3>
                <span className="chip" style={{ color: BAND_COLOR[bandFor(selMastery.mastery)] }}>
                  {BAND_LABEL[bandFor(selMastery.mastery)]}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                {selConcept.description}
              </p>
              <dl className="mono mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs" style={{ color: "var(--color-ash)" }}>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES YOU GOT IT</dt>
                  <dd className="tnum" style={{ color: "var(--color-paper)" }}>{selMastery.successfulRecallCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES YOU MISSED IT</dt>
                  <dd className="tnum">{selMastery.failedRecallCount}</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
