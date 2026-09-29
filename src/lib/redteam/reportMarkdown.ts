import type { Report, ReportClaim } from "./report";

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

/** The report as Markdown, for pasting into a review thread or a repo. */
export function reportToMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`# Defensibility Report — ${r.documentTitle}`);
  out.push("");
  out.push(`Mode: ${r.mode.toLowerCase()}. ${n(r.counts.claims, "claim")} checked, ${n(r.counts.interruptions, "interruption")}, ${n(r.counts.corrections, "correction")}.`);
  if (r.sample) out.push("", "_The document reviewed is sample material._");

  const claimBlock = (c: ReportClaim) => {
    out.push(`- **${c.claim}** — ${c.status}${c.resolved ? " (corrected in the session)" : ""}`);
    if (c.correctedFrom) out.push(`  - Corrected: this was ${c.correctedFrom.status} when first said ("${c.correctedFrom.claim}").`);
    out.push(`  - ${c.basis}`);
    for (const e of c.evidence) out.push(`  - Supports — ${e.section}: "${e.quote}"`);
    for (const e of c.contradictions) out.push(`  - Contradicts — ${e.section}: "${e.quote}"`);
  };
  const section = (title: string, items: ReportClaim[], none: string) => {
    out.push("", `## ${title}`, "");
    if (items.length === 0) out.push(none);
    for (const c of items) claimBlock(c);
  };

  section("Claims that held", r.held, "None yet.");
  section("Claims that needed qualification", r.needsQualification, "None.");
  section("Contradictions found", r.contradictions, "None.");
  section("Unsupported claims", r.unsupported, "None.");

  out.push("", "## Questions you still cannot answer", "");
  if (r.unanswered.length === 0) out.push("None.");
  for (const q of r.unanswered) {
    out.push(`- ${q.question}`);
    for (const g of q.groundedIn) out.push(`  - From ${g.section}: "${g.quote}"`);
  }

  out.push("", "## Source sections to review", "");
  if (r.sectionsToReview.length === 0) out.push("None.");
  for (const s of r.sectionsToReview) out.push(`- **${s.section}** — ${s.reasons.join("; ")}`);
  out.push("");
  return out.join("\n");
}
