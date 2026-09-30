"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { selectSampleCourse } from "@/lib/sample-course";

/**
 * "Try a sample exam". Selects the labelled sample course, then opens /oral.
 * A real link underneath (href) so it works before hydration and with JS off.
 */
export function SampleExamButton({ children = "Try a sample exam" }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <a
      href="/oral?subjectId=course_transformers_w4"
      className="btn-primary"
      aria-busy={busy || undefined}
      onClick={(e) => {
        e.preventDefault();
        setBusy(true);
        router.push(selectSampleCourse());
      }}
    >
      {busy ? "Opening the exam" : children}
    </a>
  );
}
