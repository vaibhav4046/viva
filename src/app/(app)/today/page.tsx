"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { SegmentCard } from "@/components/today/SegmentCard";
import { InlineRecall } from "@/components/today/InlineRecall";
import { WeekStrip } from "@/components/today/WeekStrip";
import { shortDate, shortTimeUtc, type DailyPath, type WeeklyProjection } from "@/components/today/types";
import {
  CoursePicker,
  fetchCourses,
  readCourseParam,
  writeStoredCourse,
  type CourseMeta,
} from "@/components/course/CoursePicker";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

type LearnerData = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: { id: string; name: string }[];
  priors: Record<string, number>;
};

type ReviewItem = {
  conceptId: string;
  conceptName: string;
  dueAt: string;
  priority: number;
  reason: string;
};

type ReviewData = { queue: ReviewItem[]; compound: string[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return (await res.json()) as T;
}

/**
 * /today — the daily 10-minute path. Path comes from GET /api/learner/path
 * (deterministic, own data only); mastery + review come from the existing
 * learner APIs. Every fetch has a loading and an error state; an inline
 * answer is only reflected after the server returns 200.
 */
export default function TodayPage() {
  const [path, setPath] = useState<DailyPath | null>(null);
  const [learner, setLearner] = useState<LearnerData | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [week, setWeek] = useState<WeeklyProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  // undefined = resolving, null = all courses (the calendar default).
  const [courseId, setCourseId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then(setCourses)
        .catch(() => setCourses([]));
      setCourseId(readCourseParam() || null);
    })();
  }, []);

  const scope = courseId ? `?courseId=${encodeURIComponent(courseId)}` : "";

  const load = useCallback(async () => {
    if (courseId === undefined) return;
    setLoading(true);
    setError(null);
    const [p, l, r, w] = await Promise.allSettled([
      getJson<DailyPath>(`/api/learner/path${scope}`),
      getJson<LearnerData>(`/api/learner${scope}`),
      getJson<ReviewData>("/api/learner/review"),
      getJson<WeeklyProjection>(`/api/learner/week${scope}`),
    ]);
    if (p.status === "fulfilled") setPath(p.value);
    if (l.status === "fulfilled") setLearner(l.value);
    if (r.status === "fulfilled") setReview(r.value);
    if (w.status === "fulfilled") setWeek(w.value);
    const failed: string[] = [];
    if (p.status === "rejected") failed.push("your 10-minute path");
    if (l.status === "rejected") failed.push("your mastery estimate");
    if (r.status === "rejected") failed.push("the review queue");
    if (w.status === "rejected") failed.push("your week projection");
    if (failed.length > 0) {
      setError(`Couldn't load ${failed.join(" and ")}. The server may be starting up — nothing was lost.`);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, scope]);

  /** After a 200 from an inline answer, refresh quietly — never a spinner. */
  const quietRefresh = useCallback(async () => {
    const [p, l, r, w] = await Promise.allSettled([
      getJson<DailyPath>(`/api/learner/path${scope}`),
      getJson<LearnerData>(`/api/learner${scope}`),
      getJson<ReviewData>("/api/learner/review"),
      getJson<WeeklyProjection>(`/api/learner/week${scope}`),
    ]);
    if (p.status === "fulfilled") setPath(p.value);
    if (l.status === "fulfilled") setLearner(l.value);
    if (r.status === "fulfilled") setReview(r.value);
    if (w.status === "fulfilled") setWeek(w.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

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

  const nameOf = useCallback(
    (id: string) => learner?.concepts.find((c) => c.id === id)?.name ?? id,
    [learner]
  );

  const queue = review?.queue ?? [];
  const thinHistory = learner ? learner.events.length <= 1 : false;

  const miscConcept = learner
    ? Object.values(learner.mastery)
        .filter((m) => m.misconceptionCount > 0)
        .sort(
          (a, b) =>
            b.misconceptionCount - a.misconceptionCount ||
            b.reviewPriority - a.reviewPriority ||
            a.conceptId.localeCompare(b.conceptId)
        )[0] ?? null
    : null;
  const compound = review?.compound ?? [];
  const recurringStatement = compound.find((s) => /confus/i.test(s)) ?? null;

  const improved = learner
    ? Object.values(learner.mastery)
        .filter((m) => m.lastSuccessfulRecallAt)
        .sort(
          (a, b) =>
            (b.lastSuccessfulRecallAt ?? "").localeCompare(a.lastSuccessfulRecallAt ?? "") ||
            a.conceptId.localeCompare(b.conceptId)
        )[0] ?? null
    : null;

  const totalMinutes = path ? path.path.reduce((n, s) => n + s.minutes, 0) : 0;

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
          actions={
            courses.length > 0 ? (
              <CoursePicker courses={courses} value={courseId ?? ""} onChange={changeCourse} allOption label="Subject" />
            ) : undefined
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
            {path ? (
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                {totalMinutes} min · built {shortTimeUtc(path.generatedAt)}
              </span>
            ) : null}
          </div>

          {path ? (
            <div className="mt-3 flex items-center gap-3">
              <div
                className="meter flex-1"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.min(10, totalMinutes)}
                aria-label="Minutes planned for today"
              >
                <span style={{ transform: `scaleX(${Math.min(1, totalMinutes / 10)})` }} />
              </div>
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                {totalMinutes} of 10 min planned
              </span>
            </div>
          ) : null}

          {loading && !path ? (
            <div className="mt-4">
              <LoadingBlock label="Composing today's path from your own events…" lines={4} />
            </div>
          ) : path && path.path.length === 0 ? (
            <div
              className="mt-4 rounded-xl border border-dashed px-5 py-6"
              style={{ borderColor: "var(--color-hairline)" }}
            >
              <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                Nothing yet. Say something in Study and tomorrow&apos;s ten minutes will be waiting here.
              </p>
              <Link href="/study" className="btn-lime mt-4">
                <Mic size={16} aria-hidden />
                Start talking
              </Link>
            </div>
          ) : path ? (
            <ol className="mt-4 space-y-3">
              {path.path.map((segment, i) => (
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
          ) : (
            <div
              className="mt-4 rounded-xl border border-dashed px-5 py-6 text-sm leading-relaxed"
              style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
            >
              The path couldn&apos;t be built right now. Use retry above — your history is intact.
            </div>
          )}
        </section>

        {week ? <WeekStrip days={week.days} /> : null}

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <section aria-labelledby="due-heading">
            <h2 id="due-heading" className="heading text-xl">
              Due for review
            </h2>
            {loading && !review ? (
              <div className="mt-4">
                <LoadingBlock label="Loading your review queue…" lines={3} />
              </div>
            ) : queue.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {queue.map((item) => (
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
                {thinHistory ? (
                  <>
                    Nothing due — say something in{" "}
                    <Link href="/study" className="underline underline-offset-4" style={{ color: "var(--color-band-getting)" }}>
                      Study
                    </Link>{" "}
                    and it will show up here.
                  </>
                ) : (
                  "Nothing due right now — review priority updates as you learn."
                )}
              </p>
            )}
          </section>

          <div className="space-y-8">
            <section aria-labelledby="recurring-heading">
              <h2 id="recurring-heading" className="heading text-xl">
                What keeps tripping you up
              </h2>
              {loading && !review && !learner ? (
                <div className="mt-4">
                  <LoadingBlock label="Reading your history…" lines={2} />
                </div>
              ) : recurringStatement ? (
                <div className="surface-card mt-4 p-4">
                  <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                    {recurringStatement}
                  </p>
                  {miscConcept ? (
                    <Link
                      href={`/map?concept=${encodeURIComponent(miscConcept.conceptId)}`}
                      className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                      style={{ color: "var(--color-band-getting)" }}
                    >
                      See it on your map →
                    </Link>
                  ) : null}
                </div>
              ) : miscConcept ? (
                <div className="surface-card mt-4 p-4">
                  <p className="text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                    <span className="font-semibold" style={{ color: "var(--color-band-mixed)" }}>
                      Mixed up ·{" "}
                    </span>
                    {nameOf(miscConcept.conceptId)} has {miscConcept.misconceptionCount} incorrect answer
                    {miscConcept.misconceptionCount === 1 ? "" : "s"} so far.
                  </p>
                  <Link
                    href={`/map?concept=${encodeURIComponent(miscConcept.conceptId)}`}
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
              {improved && improved.lastSuccessfulRecallAt ? (
                <div className="surface-card mt-4 p-4">
                  <p className="heading text-base">{nameOf(improved.conceptId)}</p>
                  <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                    You got it right on {shortDate(improved.lastSuccessfulRecallAt)} — {improved.successfulRecallCount} time{improved.successfulRecallCount === 1 ? "" : "s"} in total.
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
  );
}

function DueRow({
  item,
  courseId,
  open,
  onToggle,
  onAnswered,
}: {
  item: ReviewItem;
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
