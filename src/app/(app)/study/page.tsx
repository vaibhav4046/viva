"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { MicButton, type TypedHandle, type VoiceTurn } from "@/components/voice/MicButton";
import { OrbSlot, setOrbAnalyser, setOrbLevel } from "@/components/orb/Orb";
import type { TurnFacts } from "@/components/voice/TurnFacts";
import { Note } from "@/components/Note";
import { Graph } from "@/components/Graph";
import { SourceReader } from "@/components/SourceReader";
import { TutorPanel } from "@/components/TutorPanel";
import { QuizQuestion, QuizVerdictPanel } from "@/components/QuizCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { announceSaved } from "@/components/AppShell";
import { DeviceNote } from "@/components/ui/DeviceNote";
import { BAND_COLOR, BAND_LABEL, BAND_ORDER, bandFor, type BandKey } from "@/components/bands";
import {
  mergeLearner,
  mergeSubjectList,
  mirroredSubject,
  rememberEvent,
  rememberMastery,
  syncRecord,
  type LearnerPayload,
} from "@/components/mirror";
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

/**
 * Where a session's conversation lives between reloads.
 *
 * A student said three things, pressed F5, and "Your notes" was empty again —
 * the whole point of the product is that it remembers, and the first thing it
 * did was forget. This is the rendered conversation: the tutor's words, the open
 * question and the marked answer, which are the shape of the screen rather than
 * facts about the learner. The facts — events, mastery, subjects — live in
 * src/components/mirror.ts and are handed back to the server on load.
 *
 * Per subject, because switching subjects switches conversations.
 */
function convoKey(subjectId: string): string {
  return `viva.study.${subjectId}`;
}

type SavedConvo = {
  notes: { event: LearningEvent; concept: string | null; band: BandKey | null; facts?: TurnFacts | null }[];
  tutor: { text: string; evidenceIds: string[]; strategy: string } | null;
  quiz: { id: string; question: string } | null;
  result: Assessment | null;
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
  /*
   * `facts` rides along with the note. What the Dictation path cost — its own
   * request_time_ms, the confidence, the verbatim beside the tidied text — used
   * to exist only inside the pre-send review panel, which auto-sends after
   * 1.5 s and took all of it with it. A judge watching a ninety-second demo
   * never saw the evidence for the integration the demo is about.
   */
  const [notes, setNotes] = useState<
    { event: LearningEvent; concept: string | null; band: BandKey | null; facts?: TurnFacts | null }[]
  >([]);
  const [tutor, setTutor] = useState<{ text: string; evidenceIds: string[]; strategy: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `retry` is absent when the server said trying again would not help. */
  const [turnError, setTurnError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [quiz, setQuiz] = useState<{ id: string; question: string } | null>(null);
  const [result, setResult] = useState<Assessment | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  const [courseId, setCourseId] = useState<string | null>(null);
  /** Passage ids in the order the source rail lists them (S-1-10). */
  const [passageIds, setPassageIds] = useState<string[]>([]);
  /** The server's own sentence about where this record lives; null when durable. */
  const [storageNote, setStorageNote] = useState<string | null>(null);
  /** Set when the open subject only exists in this browser. */
  const [localOnly, setLocalOnly] = useState(false);
  /** Scrolled to when a new answer lands, so the reply is never below the fold. */
  const tutorRef = useRef<HTMLDivElement>(null);

  /** The subject whose saved conversation is currently in state. */
  const [convoFor, setConvoFor] = useState<string | null>(null);
  const conceptsRef = useRef<ConceptLite[]>([]);
  const typedRef = useRef<TypedHandle>(null);

  // Restore this subject's conversation, then keep it written down. The two
  // effects are ordered: the restore batches its setStates into one commit, so
  // by the time the writer sees convoFor === courseId the restored notes are
  // already the current ones and it cannot overwrite them with the old.
  useEffect(() => {
    if (!courseId) return;
    let saved: SavedConvo | null = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(convoKey(courseId)) || "null") as SavedConvo | null;
    } catch {
      /* private mode, or something else wrote nonsense there */
    }
    setNotes(Array.isArray(saved?.notes) ? saved.notes : []);
    setTutor(saved?.tutor ?? null);
    setQuiz(saved?.quiz ?? null);
    setResult(saved?.result ?? null);
    setConvoFor(courseId);
  }, [courseId]);

  useEffect(() => {
    if (!courseId || convoFor !== courseId) return;
    try {
      window.localStorage.setItem(convoKey(courseId), JSON.stringify({ notes, tutor, quiz, result }));
    } catch {
      /* storage full or blocked — the server still has the record */
    }
  }, [courseId, convoFor, notes, tutor, quiz, result]);

  // Resolve the subject once on the client (?subject → ?course → stored → default).
  useEffect(() => {
    void (async () => {
      // Merged with the mirror: after the server has forgotten a self-built
      // subject, the list it returns does not contain it, and the header then
      // falls back to the word "Study" over the student's own material.
      await fetchCourses()
        .then((list) => setCourses(mergeSubjectList(list) as CourseMeta[]))
        .catch(() => setCourses(mergeSubjectList([]) as CourseMeta[]));
      let fromUrl: string | null = null;
      try {
        fromUrl = new URLSearchParams(window.location.search).get("subject");
      } catch {
        /* no window (prerender) */
      }
      setCourseId(fromUrl || readCourseParam() || readStoredCourse() || DEFAULT_COURSE_ID);
    })();
  }, []);

  /**
   * Open a subject: hand the browser's record in, take the merged view back.
   *
   * `syncRecord` replays this student's events and any subject they built into
   * whichever instance answers, so the reply is a record that knows about both —
   * which is the difference between a self-built subject opening on its own
   * material and 404ing. A plain read is the fallback, and the mirror is the
   * fallback after that: a student who did the work keeps their map on screen
   * even when nothing answers.
   */
  const load = useCallback(async (cid: string) => {
    setBootLoading(true);
    setBootError(null);
    setLocalOnly(false);
    try {
      let payload = (await syncRecord(cid)) as LearnerPayload<ConceptLite> | null;
      if (payload) {
        setStorageNote(payload.storageNote ?? null);
      } else {
        const r = await fetch(`/api/learner?subject=${encodeURIComponent(cid)}`);
        if (r.ok) {
          payload = (await r.json()) as LearnerPayload<ConceptLite>;
          setStorageNote(payload.storageNote ?? null);
        }
      }

      const mine = mirroredSubject(cid);
      if (!payload) {
        // Nothing answered. If this subject is one the browser built, draw it
        // from the copy the browser kept rather than an empty screen.
        if (!mine) {
          setBootError("Couldn't open this subject. The server may still be waking up.");
          return;
        }
        setLocalOnly(true);
      }

      const merged = mergeLearner(payload ?? { mastery: {}, events: [], concepts: [] }, cid);
      if (!merged.concepts.length && mine) setLocalOnly(true);
      const next: Boot = {
        mastery: merged.mastery,
        events: merged.events,
        concepts: merged.concepts,
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
      const clientEventId = crypto.randomUUID();
      try {
        const res = await fetch("/api/study/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: t.text,
            subjectId: courseId,
            /*
             * Sent as detected, not flattened. `burst.ts` recognises a paste
             * that arrived from the student's own dictation tool and tags it
             * `external-dictation`; collapsing that to "typed" here threw the
             * tag away at the one call site that could have carried it, and
             * §4.5 asks for it. VIVA never claims an AssemblyAI path or an
             * AssemblyAI time for words another recogniser produced.
             */
            origin: t.origin,
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
            clientEventId,
          }),
        });
        /*
         * The server already wrote the sentence and already said whether trying
         * again would help. Throwing a bare Error here discarded both, so a
         * refusal the server marked `retryable: false` — words it will reject
         * identically every time — came back as the generic network line with a
         * Try again button under it. Read the body; offer the retry only when
         * the server said one was worth offering.
         */
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: { message?: string; retryable?: boolean } }
            | null;
          setTurnError({
            message:
              body?.error?.message ?? "That didn't reach VIVA. Nothing was saved — try again.",
            retry: body?.error?.retryable === false ? undefined : () => void takeTurn(t),
          });
          return;
        }
        const out = (await res.json()) as TurnOut;
        const cname = conceptsRef.current.find((c) => c.id === out.event.primaryConceptId)?.name ?? null;
        const cid = out.event.primaryConceptId;
        const moved = cid ? out.mastery[cid] : undefined;
        const nowBand = moved ? bandFor(moved.mastery, moved.exposureCount > 0) : null;
        setNotes((m) => [{ event: out.event, concept: cname, band: nowBand, facts: t }, ...m].slice(0, 8));
        setTutor({ ...out.tutor, strategy: out.assessment?.verdict ?? out.tutor.strategy });
        // After the paint, not during it: the card has to exist and have its
        // final height before scrolling to it means anything.
        requestAnimationFrame(() => {
          tutorRef.current?.scrollIntoView({
            behavior: reduced ? "auto" : "smooth",
            block: "nearest",
          });
        });
        setBoot((b) => (b ? { ...b, mastery: out.mastery, events: [...b.events, out.event] } : b));
        // Written down here as well as on whichever lambda answered, carrying the
        // id the replay dedupes on. This is the copy the next load hands back.
        rememberEvent(out.event, clientEventId);
        rememberMastery(out.mastery);
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

  /** "Next question" goes down the same road as typing it, because it is the
   *  same road: one turn endpoint, one state machine. */
  const askForAnother = useCallback(async () => {
    setResult(null);
    await takeTurn({
      text: "Quiz me on something else.",
      verbatim: "Quiz me on something else.",
      clean: "Quiz me on something else.",
      origin: "typed",
      confidence: null,
      requestTimeMs: null,
      audioMs: null,
      sessionId: null,
      asrMode: null,
      edited: false,
    });
  }, [takeTurn]);

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
    <>
      <PageHeader
        title={subject ? subject.title : "Study"}
        description="Say what you think. VIVA answers from your source and asks the one question that moves you."
        actions={
          <div className="orb-dock min-h-11 min-w-0">
            <OrbSlot className="orb-slot--dock" priority={1} />
            {courses.length > 0 ? (
              <CoursePicker courses={courses} value={courseId ?? DEFAULT_COURSE_ID} onChange={changeSubject} label="Subject" />
            ) : (
              <span className="skeleton h-9 w-44" aria-hidden />
            )}
          </div>
        }
      />

      <div className="mt-3 min-h-[28px]">
        {bandCounts.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-2" aria-label="How this subject is going">
            {bandCounts.map(({ key, count }) => (
              <li key={key} className="chip" style={{ color: BAND_COLOR[key as BandKey] }}>
                <span className="tnum">{count}</span> {BAND_LABEL[key as BandKey]}
              </li>
            ))}
          </ul>
        ) : bootLoading ? (
          <span className="skeleton block h-[26px] w-52" aria-hidden />
        ) : null}
      </div>

      {bootError ? (
        <div className="mt-4">
          <ErrorBanner message={bootError} onRetry={() => void (courseId && load(courseId))} retryLabel="Try again" />
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,34%)_minmax(0,1fr)_320px]">
        {/* Source: last on a phone, first on a wide screen. */}
        <div className="order-3 min-w-0 xl:order-1 xl:col-start-1 xl:row-start-1">
          <SourceReader highlightIds={tutor?.evidenceIds ?? []} courseId={courseId ?? undefined} onChunks={setPassageIds} />
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
          <div>
            <MicButton
              subjectId={courseId ?? DEFAULT_COURSE_ID}
              onSubmit={takeTurn}
              busy={busy}
              context={spokenContext}
              typedHandleRef={typedRef}
              onLevel={setOrbLevel}
              onAnalyser={setOrbAnalyser}
            />
          </div>

          <DeviceNote note={storageNote} />

          {localOnly ? (
            <p className="mono text-xs leading-relaxed" style={{ color: "var(--color-band-getting)" }}>
              This subject is the copy your browser kept. Your map and your notes are here; reload
              and VIVA will hand it back so it can quote your passages again.
            </p>
          ) : null}

          {turnError ? <ErrorBanner message={turnError.message} onRetry={turnError.retry} retryLabel="Try again" /> : null}
          {busy ? <LoadingBlock label="Thinking…" lines={2} /> : null}

          {/* The answer has to be on screen. Measured on the deployment at
              1280x800: after a typed turn the reply card sat at y=820 with the
              fold at 800, so the visible feedback was the map changing colour
              and nothing else. A first-time visitor reads that as "it did
              something" rather than "it answered me". */}
          <div ref={tutorRef}>
            <TutorPanel
              text={tutor?.text ?? null}
              evidenceIds={tutor?.evidenceIds ?? []}
              passageIds={passageIds}
              strategy={tutor?.strategy}
            />
          </div>

          <AnimatePresence initial={false}>
            {quiz ? (
              <m.div key={quiz.id} className="space-y-4" {...rise(reduced)}>
                <QuizQuestion
                  eyebrow="Quiz"
                  question={quiz.question}
                  status={result ? <span className="chip">Marked</span> : undefined}
                >
                  {!result ? (
                    <p className="mt-2 text-sm" style={{ color: "var(--color-ash)" }}>
                      Answer out loud with the mic above, or type it.
                    </p>
                  ) : null}
                </QuizQuestion>

                {result ? (
                  <QuizVerdictPanel
                    result={result}
                    actions={
                      <>
                        <button type="button" className="btn-lime !py-2 text-sm" disabled={busy} onClick={() => void askForAnother()}>
                          Next question →
                        </button>
                        <button type="button" className="btn-ghost !py-2 text-sm" onClick={() => setResult(null)}>
                          Answer this one again
                        </button>
                        <button
                          type="button"
                          className="btn-ghost !py-2 text-sm"
                          onClick={() => {
                            setQuiz(null);
                            setResult(null);
                          }}
                        >
                          Back to talking
                        </button>
                      </>
                    }
                  />
                ) : null}
              </m.div>
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
                  <Note key={n.event.id} event={n.event} conceptName={n.concept} band={n.band} facts={n.facts} />
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
                  <dt className="text-[11px] tracking-widest">GOT IT</dt>
                  <dd className="tnum" style={{ color: "var(--color-paper)" }}>{selMastery.successfulRecallCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] tracking-widest">MISSED</dt>
                  <dd className="tnum">{selMastery.failedRecallCount}</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
