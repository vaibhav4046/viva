"use client";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { DeviceNote } from "@/components/ui/DeviceNote";
import { mergeLearner, mergeSubjectList, syncRecord } from "@/components/mirror";
import { SegmentCard } from "@/components/today/SegmentCard";
import { InlineRecall } from "@/components/today/InlineRecall";
import { WeekStrip } from "@/components/today/WeekStrip";
import { deriveToday, type DueItem, type LearnerSnapshot } from "@/components/today/snapshot";
import { shortDate } from "@/components/today/types";
import {
  CoursePicker,
  fetchCourses,
  readCourseParam,
  writeStoredCourse,
  type CourseMeta,
} from "@/components/course/CoursePicker";

/**
 * /today — the daily 10-minute path.
 *
 * ONE fetch. GET /api/learner returns this student's mastery, their recent
 * events and the subject's concepts; every section on the screen is folded out
 * of that single object in src/components/today/snapshot.ts, using the same
 * planner the routes use. Four calls used to produce four answers that argued
 * with each other on one screen — see the note in snapshot.ts.
 *
 * Nothing below the path renders until the snapshot lands, so the page only
 * ever grows downward. It used to paint a 329 px block of loading states and
 * then collapse it to zero when the fetch came back thin, which is 0.26 of
 * layout shift under a thumb on a phone.
 */

type LearnerResponse = LearnerSnapshot & { storageNote?: string | null };

export default function TodayPage() {
  const [snapshot, setSnapshot] = useState<LearnerResponse | null>(null);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  // undefined = resolving, null = all courses (the calendar default).
  const [courseId, setCourseId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then((list) => setCourses(mergeSubjectList(list) as CourseMeta[]))
        .catch(() => setCourses(mergeSubjectList([]) as CourseMeta[]));
      setCourseId(readCourseParam() || null);
    })();
  }, []);

  const scope = courseId ? `?subject=${encodeURIComponent(courseId)}` : "";

  /**
   * One call, and the browser's own record goes with it.
   *
   * The plan is folded from the events this returns, so an instance that has
   * never seen this student composes nothing — which is how a page that had
   * just watched two answers land printed "Nothing yet". `syncRecord` replays
   * the mirror into whichever instance answers and takes the merged snapshot
   * back; `mergeLearner` then unions it with what the browser holds, so the
   * plan is never thinner than the session behind it. A read that fails
   * entirely still yields the mirror, because the student did the work.
   */
  const fetchSnapshot = useCallback(async (): Promise<LearnerResponse> => {
    let payload = (await syncRecord(courseId ?? null)) as LearnerResponse | null;
    if (!payload) {
      const res = await fetch(`/api/learner${scope}`);
      if (res.ok) payload = (await res.json()) as LearnerResponse;
    }
    if (payload) setStorageNote(payload.storageNote ?? null);
    const base: LearnerResponse =
      payload ?? ({ mastery: {}, events: [], concepts: [] } as LearnerResponse);
    const merged = mergeLearner(base, courseId ?? null);
    if (!payload && !merged.events.length) throw new Error("learner fetch failed");
    return { ...base, ...merged } as LearnerResponse;
  }, [courseId, scope]);

  const load = useCallback(async () => {
    if (courseId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchSnapshot());
    } catch {
      setError("Couldn't load your week. The server may be starting up — nothing was lost.");
    } finally {
      setLoading(false);
    }
  }, [courseId, fetchSnapshot]);

  /** After a 200 from an inline answer, refresh quietly — never a spinner. */
  const quietRefresh = useCallback(async () => {
    try {
      setSnapshot(await fetchSnapshot());
    } catch {
      /* the answer is already recorded; the next load will pick it up */
    }
  }, [fetchSnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeCourse = useCallback((id: string) => {
    const next = id || null;
    setCourseId(next);
    try {
      const url = new URL(window.location.href);
      if (next) {
        url.searchParams.set("course", next);
        writeStoredCourse(next);
      } else {
        url.searchParams.delete("course");
      }
      window.history.replaceState(null, "", url.toString());
    } catch { /* no window (prerender) */ }
  }, []);

  const view = useMemo(() => (snapshot ? deriveToday(snapshot) : null), [snapshot]);

  /*
   * One recall open at a time. Each open panel mounts a mic, and a mic owns
   * the Space key and the id on the typed box — two of them on one page is two
   * things listening to the same keystroke. It also matches what the page is
   * for: a ten-minute path is done one segment at a time.
   */
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const togglePanel = useCallback(
    (id: string) => setOpenPanel((cur) => (cur === id ? null : id)),
    []
  );

  return (
    <>
        <PageHeader
                    title="Today"
          description="Ten minutes, built from what you actually said: what you got wrong first, then what is weakest, then one thing to prove."
          /*
           * The picker's slot is 44 px before the subject list lands, not zero.
           * It was the last shift left on this screen: the header grew when the
           * courses resolved and pushed the whole path section down 56 px.
           * Same reservation /study already makes.
           */
          actions={
            <div className="flex min-h-11 min-w-0 items-center">
              {courses.length > 0 ? (
                <CoursePicker courses={courses} value={courseId ?? ""} onChange={changeCourse} allOption label="Subject" />
              ) : (
                <span className="skeleton h-9 w-44" aria-hidden />
              )}
            </div>
          }
        />

        {error ? (
          <div className="mt-4">
            <ErrorBanner message={error} onRetry={() => void load()} retryLabel="Retry" />
          </div>
        ) : null}

        <section aria-labelledby="path-heading" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="path-heading" className="heading text-xl">
              Your 10-minute path
            </h2>
            {view ? (
              // The server clock is not the student's clock. "built 18:56 UTC"
              // on a Liverpool morning is a log line, not a sentence.
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                {view.minutes} min · updated just now
              </span>
            ) : null}
          </div>

          {view && view.path.length > 0 ? (
            <div className="mt-3 flex items-center gap-3">
              <div
                className="meter flex-1"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.min(10, view.minutes)}
                aria-label="Minutes planned for today"
              >
                <span style={{ transform: `scaleX(${Math.min(1, view.minutes / 10)})` }} />
              </div>
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                {view.minutes} of 10 min planned
              </span>
            </div>
          ) : null}

          {!view ? (
            <div className="mt-4">
              {loading ? (
                <LoadingBlock label="Composing today's path from your own events…" lines={4} />
              ) : (
                <div
                  className="rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                  style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                >
                  The path couldn&apos;t be built right now. Use retry above — your history is intact.
                </div>
              )}
            </div>
          ) : view.path.length === 0 ? (
            <div
              className="mt-4 rounded-xl border border-dashed px-5 py-6"
              style={{ borderColor: "var(--color-hairline)" }}
            >
              <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                Nothing yet. Say something in Study and tomorrow&apos;s ten minutes will be waiting here.
              </p>
              {/* One shape for "Start talking" everywhere: the paper pill the
                  landing hero uses. Lime belongs to the mic. */}
              <Link href="/study" className="btn-primary mt-4">
                <Mic size={16} aria-hidden />
                Start talking
              </Link>
            </div>
          ) : (
            <ol className="mt-4 space-y-3">
              {view.path.map((segment, i) => (
                <li key={`${segment.kind}-${segment.conceptId ?? "summary"}`}>
                  <SegmentCard
                    index={i + 1}
                    segment={segment}
                    courseId={segment.courseId ?? courseId ?? undefined}
                    open={openPanel === `seg-${i}`}
                    onToggle={() => togglePanel(`seg-${i}`)}
                    onAnswered={() => void quietRefresh()}
                  />
                </li>
              ))}
            </ol>
          )}

          <div className="mt-4">
            <DeviceNote note={storageNote} />
          </div>
        </section>

        {/*
          * Everything below the path waits for the snapshot. A cold account has
          * nothing to say here, and five dashed boxes saying so in five
          * different ways is what made the screen read as placeholder.
          */}
        {view && view.hasHistory ? (
          <>
            <WeekStrip days={view.week} />

            <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
              <section aria-labelledby="due-heading">
                <h2 id="due-heading" className="heading text-xl">
                  Due for review
                </h2>
                {view.due.length > 0 ? (
                  <ul className="mt-4 space-y-3">
                    {view.due.map((item) => (
                      <DueRow
                        key={item.conceptId}
                        item={item}
                        courseId={courseId ?? undefined}
                        open={openPanel === `due-${item.conceptId}`}
                        onToggle={() => togglePanel(`due-${item.conceptId}`)}
                        onAnswered={() => void quietRefresh()}
                      />
                    ))}
                  </ul>
                ) : (
                  <p
                    className="mt-4 rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                    style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                  >
                    Nothing due right now — everything you have said is in today&apos;s ten minutes.
                  </p>
                )}
              </section>

              <div className="space-y-8">
                <section aria-labelledby="recurring-heading">
                  <h2 id="recurring-heading" className="heading text-xl">
                    What keeps tripping you up
                  </h2>
                  {view.recurring ? (
                    <div className="surface-card mt-4 p-4">
                      <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                        {view.recurring}
                      </p>
                      {view.mixedUp ? (
                        <Link
                          href={`/map?concept=${encodeURIComponent(view.mixedUp.conceptId)}`}
                          className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                          style={{ color: "var(--color-band-getting)" }}
                        >
                          See it on your map →
                        </Link>
                      ) : null}
                    </div>
                  ) : view.mixedUp ? (
                    <div className="surface-card mt-4 p-4">
                      <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                        <span className="font-semibold" style={{ color: "var(--color-band-mixed)" }}>
                          Mixed up ·{" "}
                        </span>
                        {view.nameOf(view.mixedUp.conceptId)} has {view.mixedUp.misconceptionCount} incorrect answer
                        {view.mixedUp.misconceptionCount === 1 ? "" : "s"} so far.
                      </p>
                      <Link
                        href={`/map?concept=${encodeURIComponent(view.mixedUp.conceptId)}`}
                        className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                        style={{ color: "var(--color-band-getting)" }}
                      >
                        See it on your map →
                      </Link>
                    </div>
                  ) : (
                    <p
                      className="mt-4 rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                      style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                    >
                      Nothing is tripping you up yet.
                    </p>
                  )}
                </section>

                <section aria-labelledby="improved-heading">
                  <h2 id="improved-heading" className="heading text-xl">
                    Recently improved
                  </h2>
                  {view.improved && view.improved.lastSuccessfulRecallAt ? (
                    <div className="surface-card mt-4 p-4">
                      <p className="heading text-base">{view.nameOf(view.improved.conceptId)}</p>
                      <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                        You got it right on {shortDate(view.improved.lastSuccessfulRecallAt)} — {view.improved.successfulRecallCount} time{view.improved.successfulRecallCount === 1 ? "" : "s"} in total.
                      </p>
                    </div>
                  ) : (
                    <p
                      className="mt-4 rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
                      style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                    >
                      Nothing here yet — your first right answer shows up here.
                    </p>
                  )}
                </section>
              </div>
            </div>
          </>
        ) : null}
    </>
  );
}

function DueRow({
  item,
  courseId,
  open,
  onToggle,
  onAnswered,
}: {
  item: DueItem;
  courseId?: string;
  open: boolean;
  onToggle: () => void;
  onAnswered?: () => void;
}) {
  const panelId = useId();
  return (
    <li className="surface-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="heading text-base">{item.conceptName}</h3>
        <span className="chip" title="How overdue this one is">
          {Math.round(item.priority * 100)}% priority
        </span>
      </div>
      <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
        {item.reason}
      </p>
      <p className="mono mt-1 text-xs" style={{ color: "var(--color-ash)" }}>
        due {shortDate(item.dueAt)}
      </p>
      <div className="mt-2">
        <button
          type="button"
          className="btn-ghost inline-flex min-h-11 items-center !py-2 text-sm"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
        >
          <Mic size={15} aria-hidden />
          {open ? "Hide" : "Say what you remember"}
        </button>
      </div>
      {open ? (
        <div id={panelId} className="mt-3">
          <InlineRecall conceptId={item.conceptId} conceptName={item.conceptName} courseId={courseId} onAnswered={onAnswered} />
        </div>
      ) : null}
    </li>
  );
}
