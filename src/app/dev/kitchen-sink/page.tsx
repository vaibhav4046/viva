import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PublicShell } from "@/components/PublicShell";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { CorrectionMark, LevelMeter, PassageCard, QuestionCard, StateLine, StatusChip } from "@/components/ui/exam";
import {
  DownloadIcon,
  KeyboardIcon,
  MarkIcon,
  MicrophoneIcon,
  PageMarkIcon,
  PlayIcon,
  StopIcon,
} from "@/components/ui/icons";
import { EXCERPT } from "@/lib/fixtures/excerpt";
import "./kitchen.css";

/*
 * Dev-only kitchen sink: every component in every state, so the screenshot
 * matrix covers state cheaply. It does not exist in production: the route calls
 * notFound() when NODE_ENV is "production". Forced hover, active and focus
 * states use the ks-* classes in kitchen.css, which mirror the real selectors.
 */
export const dynamic = "force-dynamic";
const { passageId: _internalId, ...visiblePassage } = EXCERPT.passage;
export const metadata: Metadata = { title: "Kitchen sink (dev only)", robots: { index: false, follow: false } };

const SWATCHES: string[] = [
  "canvas", "surface-1", "surface-2", "elevated", "text-primary", "text-secondary", "text-muted",
  "primary", "correction", "success", "warning", "info",
  "success-tint", "correction-tint", "warning-tint", "info-tint",
  "border", "border-strong", "border-focus",
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="ks-section">
      <h2 id={id} className="heading" style={{ fontSize: "var(--fs-h2)" }}>{title}</h2>
      <div className="ks-row">{children}</div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ks-cell">
      <p className="mono ks-label">{label}</p>
      {children}
    </div>
  );
}

export default function KitchenSink() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <PublicShell width="wide">
      <h1 className="heading" style={{ fontSize: "var(--fs-h1)", lineHeight: "var(--lh-h1)" }}>Kitchen sink</h1>
      <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
        Development only. Every component in every state. Not served in production.
      </p>

      <Section id="ks-color" title="Colour">
        {SWATCHES.map((name) => (
          <div key={name} className="ks-swatch">
            <span className="ks-chip" style={{ background: `var(--${name})` }} />
            <span className="mono">{name}</span>
          </div>
        ))}
      </Section>

      <Section id="ks-type" title="Type">
        <div style={{ display: "grid", gap: 8 }}>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", lineHeight: "var(--lh-display)" }}>Display, Newsreader</p>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)" }}>Heading one</p>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h2)" }}>Heading two</p>
          <p style={{ fontSize: "var(--fs-h3)", fontWeight: 600 }}>Heading three, IBM Plex Sans</p>
          <p>Body 16 px. The quick brown fox jumps over the lazy dog, then explains why in full sentences.</p>
          <p style={{ fontSize: "var(--fs-body-sm)" }}>Body small 14 px.</p>
          <p style={{ fontSize: "var(--fs-label)", fontWeight: 500 }}>Label 13 px</p>
          <p style={{ fontSize: "var(--fs-caption)" }}>Caption 12 px</p>
          <p className="mono">Mono, p. 12, 01:24, 0123456789</p>
        </div>
      </Section>

      <Section id="ks-buttons" title="Buttons">
        {(["primary", "ghost"] as const).map((kind) => {
          const cls = kind === "primary" ? "btn-primary" : "btn-ghost";
          return (
            <div key={kind} className="ks-cell">
              <p className="mono ks-label">{kind}</p>
              <div className="ks-stack">
                <button type="button" className={cls}>Default</button>
                <button type="button" className={`${cls} ks-hover`}>Hover</button>
                <button type="button" className={`${cls} ks-active`}>Active</button>
                <button type="button" className={`${cls} ks-focus`}>Focus visible</button>
                <button type="button" className={cls} disabled>Disabled</button>
                <button type="button" className={cls} aria-busy="true">Opening the exam</button>
                <button type="button" className={cls}>
                  <MicrophoneIcon size={18} />
                  With icon
                </button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section id="ks-links" title="Links, navigation, chips">
        <Labelled label="link"><a href="#ks-links" className="link">A text link</a></Labelled>
        <Labelled label="nav-link">
          <div className="ks-stack" style={{ flexDirection: "row" }}>
            <a href="#ks-links" className="nav-link">Default</a>
            <a href="#ks-links" className="nav-link" aria-current="page">Current</a>
          </div>
        </Labelled>
        <Labelled label="status chips (word plus tint)">
          <div className="ks-stack" style={{ flexDirection: "row", flexWrap: "wrap" }}>
            <StatusChip tone="success">Verified in your pages</StatusChip>
            <StatusChip tone="correction">Contradicted</StatusChip>
            <StatusChip tone="warning">Shaky</StatusChip>
            <StatusChip tone="info">Checking page 12</StatusChip>
            <StatusChip tone="neutral">Not yet</StatusChip>
          </div>
        </Labelled>
      </Section>

      <Section id="ks-fields" title="Form fields">
        <Labelled label="default">
          <label className="field-label" htmlFor="ks-a">Subject name</label>
          <input id="ks-a" className="field" defaultValue="Transformers, Week 4" autoComplete="off" />
          <p className="field-hint">Shown on the exam and the debrief.</p>
        </Labelled>
        <Labelled label="focus">
          <label className="field-label" htmlFor="ks-b">Subject name</label>
          <input id="ks-b" className="field ks-focus" defaultValue="Transformers" autoComplete="off" />
        </Labelled>
        <Labelled label="disabled">
          <label className="field-label" htmlFor="ks-c">Subject name</label>
          <input id="ks-c" className="field" defaultValue="Locked while reading" disabled autoComplete="off" />
        </Labelled>
        <Labelled label="error">
          <label className="field-label" htmlFor="ks-d">Web address</label>
          <input id="ks-d" className="field" defaultValue="notaurl" aria-invalid="true" aria-describedby="ks-d-err" autoComplete="off" />
          <p id="ks-d-err" className="field-error">That is not a web address. Include https:// at the start.</p>
        </Labelled>
        <Labelled label="select">
          <label className="field-label" htmlFor="ks-e">Spoken language</label>
          <select id="ks-e" defaultValue="en"><option value="en">English</option><option value="hi">Hindi</option></select>
        </Labelled>
      </Section>

      <Section id="ks-feedback" title="Loading, error, empty">
        <Labelled label="loading block (fixed size skeleton)">
          <LoadingBlock label="Reading your notes" lines={3} />
        </Labelled>
        <Labelled label="error banner with retry">
          <ErrorBanner message="Microphone blocked. Your browser denied access. Allow the microphone in the address bar, or use Type instead." retryLabel="Try again" onRetry={undefined} />
        </Labelled>
        <Labelled label="empty state">
          <div className="surface-card p-4" style={{ maxWidth: 420 }}>
            <p className="heading" style={{ fontSize: "var(--fs-h3)" }}>No subjects yet</p>
            <p className="mt-1" style={{ color: "var(--text-secondary)" }}>Subjects you upload appear here. Start with the sample course or add your own notes.</p>
            <button type="button" className="btn-primary mt-3">Try a sample exam</button>
          </div>
        </Labelled>
      </Section>

      <Section id="ks-exam" title="Exam components">
        <Labelled label="state line">
          <StateLine>Listening. Go ahead.</StateLine>
          <StateLine>{EXCERPT.stateLine}</StateLine>
        </Labelled>
        <Labelled label="question card"><QuestionCard>{EXCERPT.question}</QuestionCard></Labelled>
        <Labelled label="correction mark">
          <p>It loses track of <CorrectionMark>{EXCERPT.learnerWrong}</CorrectionMark>.</p>
        </Labelled>
        <Labelled label="passage card"><PassageCard {...visiblePassage} /></Labelled>
        <Labelled label="level meter (learner 0.62, examiner 0.1)"><LevelMeter learner={0.62} examiner={0.1} /></Labelled>
      </Section>

      <Section id="ks-icons" title="Icons (24 px grid, 1.5 px stroke)">
        {[
          ["microphone", MicrophoneIcon], ["stop", StopIcon], ["keyboard", KeyboardIcon],
          ["page mark", PageMarkIcon], ["play", PlayIcon], ["download", DownloadIcon],
        ].map(([name, Cmp]) => {
          const I = Cmp as typeof MicrophoneIcon;
          return (
            <div key={name as string} className="ks-swatch"><I size={28} /><span className="mono">{name as string}</span></div>
          );
        })}
        <div className="ks-swatch"><MarkIcon size={28} /><span className="mono">brand mark</span></div>
      </Section>

      <Section id="ks-overlay" title="Modal (the only shadow)">
        <div className="ks-modal" role="dialog" aria-label="Example dialog, not interactive">
          <p className="heading" style={{ fontSize: "var(--fs-h3)" }}>End the exam?</p>
          <p className="mt-1" style={{ color: "var(--text-secondary)" }}>Your answers so far are kept and the debrief sheet is built from them.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary">End and see debrief</button>
            <button type="button" className="btn-ghost">Keep going</button>
          </div>
        </div>
      </Section>
    </PublicShell>
  );
}
