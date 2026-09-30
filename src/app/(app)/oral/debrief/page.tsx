"use client";
import Link from "next/link";
import { useEffect } from "react";
import { DebriefArea } from "@/components/oral/DebriefArea";
import { useOralSession } from "@/components/oral/useOralSession";
import "@/components/oral/oral.css";

/**
 * /oral/debrief: the printable sheet from the last exam finished in this
 * browser. The record is rebuilt into a sheet by the server, which re-checks
 * every quote against the learner's pages.
 */
export default function DebriefPage() {
  const { debrief, loadLast } = useOralSession({ diag: false });
  useEffect(() => {
    void loadLast();
  }, [loadLast]);

  return (
    <div className="oral">
      <p className="no-print"><Link href="/oral" className="link">Back to the exam</Link></p>
      {debrief.status === "idle" ? (
        <section className="debrief" role="status" aria-busy="true" style={{ minHeight: "26rem" }}>
          <p className="mono debrief-meta">Opening your last debrief</p>
        </section>
      ) : (
        <DebriefArea state={debrief} level={1} onRetry={loadLast} />
      )}
    </div>
  );
}
