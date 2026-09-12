"use client";

/**
 * Shared course picker + the one storage key all pages agree on.
 * The selection is cosmetic; every API call still resolves the course
 * server-side and falls back to the default lab for unknown ids.
 */

export const COURSE_STORAGE_KEY = "viva_course";
export const DEFAULT_COURSE_ID = "course_transformers_w4";

export type CourseMeta = {
  id: string;
  code: string;
  title: string;
  subject: string;
  conceptCount: number;
  chunkCount: number;
  examCount: number;
  trapCount: number;
};

export async function fetchCourses(): Promise<CourseMeta[]> {
  const res = await fetch("/api/courses");
  if (!res.ok) throw new Error("courses fetch failed");
  const data = (await res.json()) as { courses?: CourseMeta[] };
  return Array.isArray(data.courses) ? data.courses : [];
}

export function readStoredCourse(): string {
  try {
    return window.localStorage.getItem(COURSE_STORAGE_KEY) || DEFAULT_COURSE_ID;
  } catch {
    return DEFAULT_COURSE_ID;
  }
}

export function writeStoredCourse(id: string): void {
  try {
    window.localStorage.setItem(COURSE_STORAGE_KEY, id);
  } catch {
    /* private mode / storage disabled — selection simply doesn't persist */
  }
}

/** Read ?course= without useSearchParams (keeps these pages Suspense-free). */
export function readCourseParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("course");
  } catch {
    return null;
  }
}

export function CoursePicker({
  courses,
  value,
  onChange,
  allOption = false,
  label = "Course",
}: {
  courses: CourseMeta[];
  value: string;
  onChange: (id: string) => void;
  /** Today defaults to all labs: adds an explicit "All courses" option. */
  allOption?: boolean;
  label?: string;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="mono text-[10px] tracking-widest" style={{ color: "var(--color-ash)" }}>
        {label.toUpperCase()}
      </span>
      {/* The chevron is ours, not the OS's: globals.css strips `appearance`
          from every select and paints /ui/chevron-down.svg in its place, and
          this control keeps the system's own 44 px floor. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Select course"
        className="mono max-w-[15rem] min-w-0 rounded-lg border px-3 text-xs"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        {allOption ? <option value="">All courses</option> : null}
        {courses.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.title}
          </option>
        ))}
      </select>
    </label>
  );
}
