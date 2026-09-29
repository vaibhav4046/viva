import type { Metadata } from "next";
import { DraftNotice, PublicShell } from "@/components/PublicShell";

/* Rendered per request so the CSP nonce reaches Next's bootstrap scripts (see src/proxy.ts). */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms: VIVA",
  description: "Terms for using VIVA during the hackathon: acceptable use, no guarantees, and what to check yourself.",
};

export default function TermsPage() {
  return (
    <PublicShell>
      <h1 className="heading text-[clamp(1.75rem,1.4rem+1.4vw,2.5rem)]">Terms</h1>
      <div className="mt-4"><DraftNotice /></div>

      <div className="mt-6 space-y-8">
        <section aria-labelledby="t-what">
          <h2 id="t-what" className="heading text-xl">What this is</h2>
          <p>
            VIVA is a hackathon project. It examines you aloud on material you supply. It is offered as it is, and it
            may be offline, slow or reset at any time while the hackathon runs.
          </p>
        </section>

        <section aria-labelledby="t-wrong">
          <h2 id="t-wrong" className="heading text-xl">The examiner can be wrong</h2>
          <p>
            A language model marks your answers and speaks the feedback. Corrections are checked by code against the
            passages you supplied, and a page number is attached so you can read the source. Check the cited page
            before you rely on a correction. VIVA does not know whether your notes are right, only whether your answer
            matches them. Nothing here predicts or guarantees an exam result.
          </p>
        </section>

        <section aria-labelledby="t-use">
          <h2 id="t-use" className="heading text-xl">Acceptable use</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Upload only material you have the right to use.</li>
            <li>Do not use VIVA to break another service&apos;s rules, or to send abusive, unlawful or harmful content.</li>
            <li>Do not probe, overload or scrape the service. Report security problems as described in SECURITY.md.</li>
            <li>VIVA is a study aid. Do not use it during an assessed exam in a way your institution forbids.</li>
          </ul>
        </section>

        <section aria-labelledby="t-liab">
          <h2 id="t-liab" className="heading text-xl">Liability [NEEDS LEGAL REVIEW]</h2>
          <p>
            To the extent the law allows, the service comes with no warranty and the author is not liable for loss
            arising from its use. This section is a placeholder for wording a qualified professional must write.
          </p>
        </section>

        <section aria-labelledby="t-law">
          <h2 id="t-law" className="heading text-xl">Governing law and contact [NEEDS LEGAL REVIEW]</h2>
          <p>
            Governing law: not yet decided. Contact: a placeholder in SECURITY.md until the owner adds a real address.
          </p>
        </section>
      </div>
    </PublicShell>
  );
}
