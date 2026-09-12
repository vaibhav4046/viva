"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MotionConfig } from "motion/react";
import { Nav } from "@/components/Nav";
import { Graph } from "@/components/Graph";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ConceptDetail } from "@/components/memory/ConceptDetail";
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

type LearnerData = {
  mastery: Record<string, ConceptMastery>;
  events: LearningEvent[];
  concepts: { id: string; name: string; description: string; related?: string[] }[];
  priors: Record<string, number>;
};

type QueueItem = { conceptId: string; conceptName: string; dueAt: string; priority: number; reason: string };
type ReviewData = { queue: QueueItem[]; compound: string[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed`);
  return (await res.json()) as T;
}

type Tab = "human" | "exploration";

/**
 * /memory — "What VIVA thinks you know".
 * HUMAN (default) groups concepts by VIVA estimate band + two flags
 * (misconception, due); EXPLORATION reuses the Misconception Graph.
 * The detail panel is §20's story + §23's replay, both built only from
 * recorded events and the mastery record.
 */
export default function MemoryPage() {
  const [learner, setLearner] = useState<LearnerData | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("human");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseMeta[]>([]);
  // null until the client resolves ?course → stored → default.
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
    const [l, r] = await Promise.allSettled([
      getJson<LearnerData>(`/api/learner?courseId=${encodeURIComponent(courseId)}`),
      getJson<ReviewData>("/api/learner/review"),
    ]);
    if (l.status === "fulfilled") {
      setLearner(l.value);
      setSelectedId((prev) => (prev && l.value.mastery[prev] ? prev : null));
    }
    if (r.status === "fulfilled") setReview(r.value);
    const failed: string[] = [];
    if (l.status === "rejected") failed.push("your mastery estimate");
    if (r.status === "rejected") failed.push("the review queue");
    if (failed.length > 0) setError(`Couldn't load ${failed.join(" and ")}. The server may be starting up.`);
    setLoading(false);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeCourse = useCallback((id: string) => {
    if (!id || id === courseId) return;
    writeStoredCourse(id);
    setSelectedId(null);
    setCourseId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("course", id);
      window.history.replaceState(null, "", url.toString());
    } catch { /* no window (prerender) */ }
  }, [courseId]);

  // Deep link support (?concept=c_position) without useSearchParams,
  // which would force a Suspense boundary on this fully client page.
  useEffect(() => {
    if (!learner || selectedId) return;
    try {
      const wanted = new URLSearchParams(window.location.search).get("concept");
      if (wanted && learner.mastery[wanted]) setSelectedId(wanted);
    } catch {
      /* no window (prerender) — selection stays empty */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learner]);

  const selectConcept = useCallback((id: string) => {
    setSelectedId(id);
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
    );
  }, []);

  const nameOf = useCallback(
    (id: string) => learner?.concepts.find((c) => c.id === id)?.name ?? id,
    [learner]
  );

  const seen = learner
    ? Object.values(learner.mastery).filter((m) => m.exposureCount > 0)
    : [];
  const bands = [...seen].sort((a, b) => b.mastery - a.mastery || a.conceptId.localeCompare(b.conceptId));
  const groups: { key: string; label: string; hint: string; items: ConceptMastery[] }[] = [
    { key: "strong", label: "Strong", hint: "VIVA estimate ≥ 65%", items: bands.filter((m) => m.mastery >= 0.65) },
    { key: "developing", label: "Developing", hint: "45–65%", items: bands.filter((m) => m.mastery >= 0.45 && m.mastery < 0.65) },
    { key: "uncertain", label: "Uncertain", hint: "35–45%", items: bands.filter((m) => m.mastery >= 0.35 && m.mastery < 0.45) },
    {
      key: "misconception",
      label: "Misconception",
      hint: "≥1 incorrect claim on record",
      items: [...seen]
        .filter((m) => m.misconceptionCount > 0)
        .sort((a, b) => b.misconceptionCount - a.misconceptionCount || b.reviewPriority - a.reviewPriority || a.conceptId.localeCompare(b.conceptId)),
    },
    {
      key: "due",
      label: "Due for recall",
      hint: "review priority ≥ 55%",
      items: [...seen]
        .filter((m) => m.reviewPriority >= 0.55)
        .sort((a, b) => b.reviewPriority - a.reviewPriority || a.conceptId.localeCompare(b.conceptId)),
    },
  ];

  const selectedM = selectedId && learner ? learner.mastery[selectedId] : null;
  const selectedConcept = learner?.concepts.find((c) => c.id === selectedId) ?? null;
  const queueItem = review?.queue.find((q) => q.conceptId === selectedId) ?? null;
  const priors = learner?.priors ?? {};

  return (
    <MotionConfig reducedMotion="user">
      <Nav />
      <main id="main" className="mx-auto max-w-6xl px-5 py-8">
        <PageHeader
          eyebrow="{ memory }"
          title="What VIVA thinks you know"
          description="Every estimate is a deterministic fold over your own events. Bands and flags are rules you can read — never a claim about your brain."
          actions={
            courses.length > 0 && courseId ? (
              <CoursePicker courses={courses} value={courseId} onChange={changeCourse} />
            ) : undefined
          }
        />

        {error ? (
          <div className="mt-4">
            <ErrorBanner message={error} onRetry={() => void load()} retryLabel="Retry" />
          </div>
        ) : null}

        <div
          role="tablist"
          aria-label="Memory view"
          className="mt-5 inline-flex gap-1 rounded-full border hairline p-1"
          style={{ background: "var(--color-graphite)" }}
        >
          {(["human", "exploration"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              id={`tab-${t}`}
              aria-selected={tab === t}
              aria-controls="memory-panel"
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const next: Tab = t === "human" ? "exploration" : "human";
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              className={tab === t ? "btn-lime !px-4 !py-1.5 text-sm" : "btn-ghost !border-transparent !px-4 !py-1.5 text-sm"}
            >
              {t === "human" ? "Human" : "Exploration"}
            </button>
          ))}
        </div>

        <div
          id="memory-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]"
        >
          <div>
            {loading && !learner ? (
              <LoadingBlock label="Loading your concept estimates…" lines={6} />
            ) : tab === "human" ? (
              seen.length === 0 ? (
                <div
                  className="rounded-xl border border-dashed px-5 py-8 text-sm leading-relaxed"
                  style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
                >
                  No concept has events yet — capture a thought in{" "}
                  <Link href="/demo" className="underline underline-offset-4" style={{ color: "var(--color-signal)" }}>
                    Study
                  </Link>{" "}
                  and this page starts filling in.
                </div>
              ) : (
                <div className="space-y-6">
                  {groups.map((g) =>
                    g.items.length === 0 ? null : (
                      <section key={g.key} aria-labelledby={`group-${g.key}`}>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h2 id={`group-${g.key}`} className="heading text-base">
                            {g.label}
                          </h2>
                          <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                            {g.hint}
                          </span>
                        </div>
                        <ul className="mt-2 space-y-2">
                          {g.items.map((m) => (
                            <li key={`${g.key}-${m.conceptId}`}>
                              <button
                                type="button"
                                onClick={() => selectConcept(m.conceptId)}
                                aria-pressed={selectedId === m.conceptId}
                                className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-white/5"
                                style={{
                                  background: "var(--color-graphite)",
                                  borderColor: selectedId === m.conceptId ? "var(--color-cognition)" : "var(--color-hairline)",
                                }}
                              >
                                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                  <span className="heading text-base">{nameOf(m.conceptId)}</span>
                                  <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                                    VIVA estimate {Math.round(m.mastery * 100)}%
                                  </span>
                                </span>
                                <span className="mono mt-1 block text-[11px]" style={{ color: "var(--color-ash)" }}>
                                  {m.exposureCount} exposure{m.exposureCount === 1 ? "" : "s"} · {m.confusionCount} confusion
                                  {m.confusionCount === 1 ? "" : "s"} · {m.misconceptionCount} misconception
                                  {m.misconceptionCount === 1 ? "" : "s"} · {m.successfulRecallCount} correct · {m.failedRecallCount} failed
                                </span>
                                {priors[m.conceptId] !== undefined ? (
                                  <span className="chip mt-2" title="Labeled start value for the seeded track — not measured.">
                                    demo prior {Math.round(priors[m.conceptId] * 100)}%
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  )}
                  <p className="mono text-[11px]" style={{ color: "var(--color-ash)" }}>
                    Bands follow fixed thresholds; unseen concepts stay out until an event touches them. A concept can appear in
                    a band and in the Misconception or Due flags at the same time.
                  </p>
                </div>
              )
            ) : learner ? (
              <Graph mastery={learner.mastery} selected={selectedId} onSelect={selectConcept} concepts={learner.concepts} />
            ) : (
              <LoadingBlock label="Loading the graph…" lines={5} />
            )}
          </div>

          <div ref={detailRef} className="min-w-0">
            {selectedM && selectedConcept ? (
              <ConceptDetail
                concept={selectedConcept}
                mastery={selectedM}
                prior={learner?.priors[selectedConcept.id]}
                queueItem={queueItem}
                events={learner?.events ?? []}
              />
            ) : (
              <div className="surface-card p-5 text-sm leading-relaxed" style={{ color: "var(--color-ash)" }}>
                {loading
                  ? "Loading concept detail…"
                  : "Select a concept to see its story: first confusion, evidence, correction and next review."}
              </div>
            )}
          </div>
        </div>
      </main>
    </MotionConfig>
  );
}
