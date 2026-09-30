import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COURSES } from "@/lib/courses";
import { blankMastery, reduceMastery } from "@/lib/mastery";
import { buildDebrief, type SessionRecord } from "@/lib/oral/debrief";
import { ORAL_FAILURES } from "@/lib/oral/failures";
import { ORAL_STATES } from "@/lib/oral/machine";
import { DebriefSheet } from "@/components/oral/DebriefSheet";
import { OralFixture } from "@/components/oral/OralFixture";
import { parseScenario } from "@/components/oral/fixtureScenario";
import type { ConceptMastery, LearningEvent } from "@/lib/types";

/*
 * Dev only: every /oral state, every failure screen and the debrief sheet, drawn
 * by the real components from fixture data, so the screenshot matrix and axe can
 * visit each one. Returns 404 in production. Nothing on this page is measured.
 *
 *   /dev/oral-states?scenario=speaking
 *   /dev/oral-states?scenario=failure-mic_denied
 *   /dev/oral-states?scenario=debrief
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Oral states (dev only)", robots: { index: false, follow: false } };

const NOW = new Date("2026-09-29T19:00:00.000Z");
const ROW = "flex flex-wrap gap-2";

function fixtureDebrief() {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures/sessions/oral-recorded-session.json"), "utf8")) as { record: SessionRecord };
  const course = COURSES.course_transformers_w4;
  const chunks = course.sources.flatMap((s) => s.chunks);
  const mastery: Record<string, ConceptMastery> = {};
  const events: LearningEvent[] = [];
  raw.record.entries.forEach((e, i) => {
    const assessment = e.kind === "claim" ? (e.verdict === "supported" ? "correct" : e.verdict === "contradicted" ? "incorrect" : null) : e.grade;
    if (!e.conceptId || !assessment) return;
    const prev = mastery[e.conceptId] ?? blankMastery(e.conceptId, NOW.toISOString());
    mastery[e.conceptId] = reduceMastery(prev, { intent: "claim", createdAt: NOW.toISOString(), assessment, masterySignal: assessment === "correct" ? "up" : "down" }).next;
    events.push({ id: `ev${i}`, intent: "claim", primaryConceptId: e.conceptId, assessment, confusion: assessment === "incorrect" ? 0.8 : 0.1, createdAt: new Date(NOW.getTime() + i * 1000).toISOString() } as unknown as LearningEvent);
  });
  const debrief = buildDebrief({ record: raw.record, concepts: course.concepts, chunks, mastery, events, now: NOW });
  debrief.storage = { durable: false, note: "Demo storage resets when the server restarts." };
  return debrief;
}

export default async function OralStates({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { scenario } = await searchParams;

  if (scenario === "debrief") {
    return (
      <div className="oral">
        <p className="mono no-print" style={{ color: "var(--text-muted)" }}>Fixture: recorded session fixture with a synthetic learner. Dev only.</p>
        <DebriefSheet debrief={fixtureDebrief()} level={1} />
      </div>
    );
  }

  const parsed = parseScenario(scenario);
  if (parsed) return <OralFixture scenario={parsed} />;

  const link = (id: string, label: string) => (
    <Link key={id} href={`/dev/oral-states?scenario=${id}`} className="btn-ghost">{label}</Link>
  );
  return (
    <div className="grid gap-5">
      <h1 className="heading" style={{ fontSize: "var(--fs-h1)" }}>Oral states (dev only)</h1>
      <p style={{ color: "var(--text-secondary)" }}>Fixture data drawn by the real components. Nothing here is measured.</p>
      <section aria-labelledby="s-states" className="grid gap-2">
        <h2 id="s-states" className="heading" style={{ fontSize: "var(--fs-h2)" }}>Machine states</h2>
        <div className={ROW}>{ORAL_STATES.map((s) => link(s.toLowerCase(), s))}</div>
      </section>
      <section aria-labelledby="s-fail" className="grid gap-2">
        <h2 id="s-fail" className="heading" style={{ fontSize: "var(--fs-h2)" }}>Failure screens</h2>
        <div className={ROW}>{ORAL_FAILURES.map((f) => link(`failure-${f.id}`, f.id))}</div>
      </section>
      <section aria-labelledby="s-other" className="grid gap-2">
        <h2 id="s-other" className="heading" style={{ fontSize: "var(--fs-h2)" }}>Other</h2>
        <div className={ROW}>{link("typed", "typed")}{link("diag", "diagnostics, empty")}{link("debrief", "debrief sheet")}</div>
      </section>
    </div>
  );
}
