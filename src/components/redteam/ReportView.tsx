"use client";
import { useState } from "react";
import type { Report, ReportClaim } from "@/lib/redteam/report";
import { reportToMarkdown } from "@/lib/redteam/reportMarkdown";
import { STATUS_META } from "./status";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Quote({ section, quote }: { section: string; quote: string }) {
  return (
    <blockquote className="rt-quote">
      {quote}
      <small>{section}</small>
    </blockquote>
  );
}

function ClaimItem({ c }: { c: ReportClaim }) {
  const meta = STATUS_META[c.status];
  return (
    <li className="rt-item" data-status={c.status}>
      <p className="rt-item__claim">{c.claim}</p>
      <p className="rt-card__meta">
        <span className="rt-shape" data-shape={meta.shape} aria-hidden />
        <span>{meta.label}</span>
        {c.correctedFrom ? <span className="rt-card__shift">was {STATUS_META[c.correctedFrom.status].label.toLowerCase()} before your correction</span> : null}
        {c.resolved ? <span className="rt-card__shift">corrected in the session</span> : null}
      </p>
      <p className="rt-card__why">{c.basis}</p>
      {c.evidence.map((e) => (
        <Quote key={`s${e.passageId}`} section={`Supports · ${e.section}`} quote={e.quote} />
      ))}
      {c.contradictions.map((e) => (
        <Quote key={`c${e.passageId}`} section={`Contradicts · ${e.section}`} quote={e.quote} />
      ))}
    </li>
  );
}

function Group({ title, note, items, none }: { title: string; note?: string; items: ReportClaim[]; none: string }) {
  return (
    <section aria-label={title}>
      <h2>
        {title} <small>{items.length}</small>
      </h2>
      {note ? <p className="rt-none">{note}</p> : null}
      {items.length === 0 ? <p className="rt-none">{none}</p> : <ul className="rt-cards">{items.map((c) => <ClaimItem key={c.claimId} c={c} />)}</ul>}
    </section>
  );
}

export function ReportView({ report, onBack }: { report: Report; onBack?: () => void }) {
  const [copied, setCopied] = useState(false);
  const md = reportToMarkdown(report);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the download button still works.
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "defensibility-report.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article className="rt-report" aria-labelledby="rt-report-title" data-testid="report">
      <header className="rt-report__head">
        <p className="rt-label">Defensibility Report</p>
        <h1 id="rt-report-title">{report.documentTitle}</h1>
        <p className="rt-report__counts">
          <span>{plural(report.counts.claims, "claim")} checked</span>
          <span>{plural(report.counts.questions, "question")} asked</span>
          <span>{plural(report.counts.interruptions, "interruption")}</span>
          <span>{plural(report.counts.corrections, "correction")}</span>
          <span>mode: {report.mode.toLowerCase()}</span>
        </p>
        {report.sample ? <p className="rt-note">This review ran on sample material, not your document.</p> : null}
        <div className="rt-report__actions">
          {onBack ? (
            <button className="rt-btn" onClick={onBack}>
              Back to the review
            </button>
          ) : null}
          <button className="rt-btn" onClick={copy}>
            {copied ? "Copied" : "Copy as Markdown"}
          </button>
          <button className="rt-btn" onClick={download}>
            Download .md
          </button>
          <button className="rt-btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>

      <Group title="Claims that held" items={report.held} none="Nothing you said was backed by the document yet." />
      <Group title="Claims that needed qualification" items={report.needsQualification} none="No claim was only partly backed." />
      <Group title="Contradictions found" items={report.contradictions} none="Nothing you said was contradicted by the document." />
      <Group title="Unsupported claims" note="Unsupported means the document has nothing on it. It does not mean the claim is false." items={report.unsupported} none="No unsupported claims." />

      <section aria-label="Questions you still cannot answer">
        <h2>
          Questions you still cannot answer <small>{report.unanswered.length}</small>
        </h2>
        {report.unanswered.length === 0 ? (
          <p className="rt-none">Every question you were asked ended in a claim the document backs.</p>
        ) : (
          <ul className="rt-cards">
            {report.unanswered.map((q, i) => (
              <li key={i} className="rt-item">
                <p className="rt-item__claim">{q.question}</p>
                {q.groundedIn.map((g) => (
                  <Quote key={g.passageId} section={g.section} quote={g.quote} />
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Source sections to review">
        <h2>
          Source sections to review <small>{report.sectionsToReview.length}</small>
        </h2>
        {report.sectionsToReview.length === 0 ? (
          <p className="rt-none">No section needs reopening.</p>
        ) : (
          <ul className="rt-cards">
            {report.sectionsToReview.map((s) => (
              <li key={s.section} className="rt-item">
                <p className="rt-item__claim">{s.section}</p>
                <p className="rt-card__why">{s.reasons.join("; ")}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
