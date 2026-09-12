"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Layers } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { fetchCourses, writeStoredCourse, type CourseMeta } from "@/components/course/CoursePicker";

/*
 * /subjects — pick what you're studying.
 *
 * Starters are live. "Bring your own" is deliberately honest about not being
 * wired yet rather than showing a form that throws: builder-tutor owns
 * POST /api/subjects/create, and this page picks it up the moment it exists.
 */
export default function SubjectsPage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<CourseMeta[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    void fetchCourses()
      .then(setSubjects)
      .catch(() => setError(true));
  }, []);

  function open(id: string) {
    writeStoredCourse(id);
    router.push(`/study?subject=${encodeURIComponent(id)}`);
  }

  return (
    <main id="main" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Subjects"
        description="Start with one of ours, or bring your own notes and let VIVA build the map."
      />

      {error ? (
        <div className="mt-5">
          <ErrorBanner message="Couldn't load your subjects. The server may still be waking up." onRetry={() => location.reload()} retryLabel="Try again" />
        </div>
      ) : null}

      {subjects === null && !error ? (
        <div className="mt-5">
          <LoadingBlock label="Loading subjects…" lines={3} />
        </div>
      ) : null}

      <ul className="mt-5 grid gap-4 sm:grid-cols-2">
        {(subjects ?? []).map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => open(s.id)}
              className="surface-card flex h-full w-full flex-col items-start gap-2 p-5 text-left transition-colors hover:border-[var(--color-cognition)]"
            >
              <span className="eyebrow">{s.subject}</span>
              <span className="heading text-lg">{s.title}</span>
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                <span className="tnum">{s.conceptCount}</span> concepts · <span className="tnum">{s.examCount}</span> questions
              </span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-sm" style={{ color: "var(--color-cognition)" }}>
                Start talking <ArrowRight size={15} aria-hidden />
              </span>
            </button>
          </li>
        ))}

        <li>
          <div className="surface-card flex h-full flex-col items-start gap-2 border-dashed p-5">
            <span className="eyebrow inline-flex items-center gap-1.5">
              <Layers size={13} aria-hidden /> Bring your own
            </span>
            <span className="heading text-lg">Your own notes</span>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
              Paste a lecture, drop a PDF, or just name the topic. VIVA writes the map, the questions and the passages it
              will quote back at you.
            </p>
            <span className="mono mt-auto pt-3 text-xs" style={{ color: "var(--color-ash)" }}>
              Landing shortly.
            </span>
          </div>
        </li>
      </ul>
    </main>
  );
}
