"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Graph } from "@/components/Graph";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
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
import type { ConceptMastery, LearningEvent } from "@/lib/types";

/*
 * /map — what VIVA has picked up about this subject.
 *
 * One view, not two. The old page split the same data into "Human" and
 * "Exploration" tabs, which meant a student had to pick a mode before seeing
 * anything. Now: the map, and the history of whichever node you click.
 */

type LearnerData = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: { id: string; name: string; description: string; related?: string[] }[];
};

export default function MapPage() {
  const [data, setData] = useState<LearnerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  const [courseId, setCourseId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      await fetchCourses()
        .then(setCourses)
        .catch(() => setCourses([]));
      setCourseId(readCourseParam() || readStoredCourse() || DEFAULT_COURSE_ID);
    })();
  }, []);

  const load = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/learner?courseId=${encodeURIComponent(courseId)}`);
      if (!res.ok) throw new Error("learner failed");
      const d = (await res.json()) as LearnerData;
      setData(d);
      setSelectedId((prev) => (prev && d.mastery[prev] ? prev : null));
    } catch {
      setError("Couldn't open your map. The server may still be waking up.");
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeSubject(id: string) {
    if (!id || id === courseId) return;
    writeStoredCourse(id);
    setSelectedId(null);
    setCourseId(id);
  }

  const select = useCallback((id: string) => {
    setSelectedId(id);
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
  }, []);

  const concept = data?.concepts.find((c) => c.id === selectedId) ?? null;
  const mastery = selectedId && data ? data.mastery[selectedId] : null;
  const history = data && selectedId ? data.events.filter((e) => e.conceptIds.includes(selectedId)).slice(-8).reverse() : [];

  const counts = data
    ? BAND_ORDER.map((key) => ({
        key,
        count: data.concepts.filter(
          (c) => bandFor(data.mastery[c.id]?.mastery, Boolean(data.mastery[c.id]?.exposureCount)) === key
        ).length,
      })).filter((b) => b.count > 0)
    : [];

  return (
    <>
      <PageHeader
        title="Your map"
        description="Every concept in this subject, and how it is going. Tap one to see what you said about it."
        actions={
          courses.length > 0 && courseId ? (
            <CoursePicker courses={courses} value={courseId} onChange={changeSubject} label="Subject" />
          ) : undefined
        }
      />

      {counts.length > 0 ? (
        <ul className="mt-3 flex flex-wrap items-center gap-2" aria-label="Concepts by band">
          {counts.map(({ key, count }) => (
            <li key={key} className="chip" style={{ color: BAND_COLOR[key as BandKey] }}>
              <span className="tnum">{count}</span> {BAND_LABEL[key as BandKey]}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <div className="mt-4">
          <ErrorBanner message={error} onRetry={() => void load()} retryLabel="Try again" />
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {data ? (
            <Graph mastery={data.mastery} selected={selectedId} onSelect={select} concepts={data.concepts} title={null} />
          ) : loading ? (
            <LoadingBlock label="Opening your map…" lines={6} />
          ) : null}
        </div>

        <div ref={detailRef} className="min-w-0">
          {concept && mastery ? (
            <section aria-label={`${concept.name} history`} className="surface-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="heading text-lg">{concept.name}</h2>
                <span className="chip" style={{ color: BAND_COLOR[bandFor(mastery.mastery, mastery.exposureCount > 0)] }}>
                  {BAND_LABEL[bandFor(mastery.mastery, mastery.exposureCount > 0)]}
                </span>
              </div>
              <p className="prose-measure mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
                {concept.description}
              </p>

              <dl className="mono mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs" style={{ color: "var(--color-ash)" }}>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES YOU GOT IT</dt>
                  <dd className="tnum" style={{ color: "var(--color-paper)" }}>{mastery.successfulRecallCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES YOU MISSED IT</dt>
                  <dd className="tnum">{mastery.failedRecallCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES YOU SAID YOU WERE LOST</dt>
                  <dd className="tnum">{mastery.confusionCount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] tracking-widest">TIMES IT CAME UP</dt>
                  <dd className="tnum">{mastery.exposureCount}</dd>
                </div>
              </dl>

              <h3 className="heading mt-5 text-base">What you said</h3>
              {history.length === 0 ? (
                <p className="mt-2 text-sm" style={{ color: "var(--color-ash)" }}>
                  Nothing on this one yet.{" "}
                  <Link href="/study" className="underline underline-offset-4" style={{ color: "var(--color-cognition)" }}>
                    Go and talk about it
                  </Link>
                  .
                </p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {history.map((e) => (
                    <li key={e.id} className="border-l-2 pl-3 text-sm leading-relaxed" style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}>
                      “{e.cleanedTranscript}”
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : (
            <p className="surface-card p-5 text-sm" style={{ color: "var(--color-ash)" }}>
              Tap a concept on the map to see what you said about it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
