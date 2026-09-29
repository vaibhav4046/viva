import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/components/PublicShell";

/* Rendered per request so the CSP nonce reaches Next's bootstrap scripts (see src/proxy.ts). */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About: VIVA",
  description: "Who built VIVA, why, and where the source is.",
};

export default function AboutPage() {
  return (
    <PublicShell>
      <h1 className="heading text-[clamp(1.75rem,1.4rem+1.4vw,2.5rem)]">About</h1>
      <div className="mt-6 space-y-8">
        <section aria-labelledby="ab-who">
          <h2 id="ab-who" className="heading text-xl">Who built it</h2>
          <p>
            One person: Vaibhav Lalwani, a computer science student. VIVA started as a study tool that listens while
            you think aloud. The oral exam was added for the AssemblyAI Voice Agent hackathon.
          </p>
        </section>

        <section aria-labelledby="ab-why">
          <h2 id="ab-why" className="heading text-xl">Why</h2>
          <p>
            Reading notes back is easy to mistake for knowing them. A viva or an oral exam makes you say the answer
            with the pages closed, and that is a different skill. VIVA gives you that practice on your own lecture
            notes, at any hour, and points at the page when you are wrong.
          </p>
        </section>

        <section aria-labelledby="ab-how">
          <h2 id="ab-how" className="heading text-xl">What it uses</h2>
          <p>
            AssemblyAI&apos;s Voice Agent API for speech in, speech out, turn detection and tool calls. A language model
            for marking. Your own pages for every quotation, checked by code. The{" "}
            <Link href="/privacy" className="link">privacy page</Link> lists every service that sees your text.
          </p>
        </section>

        <section aria-labelledby="ab-src">
          <h2 id="ab-src" className="heading text-xl">Source</h2>
          <p>
            The code is at{" "}
            <a className="link" href="https://github.com/vaibhav4046/viva" target="_blank" rel="noopener noreferrer">
              github.com/vaibhav4046/viva
            </a>
            . Fonts (Newsreader, IBM Plex Sans, IBM Plex Mono) are under the SIL Open Font License. Libraries and their
            licences are listed in THIRD-PARTY.md in the repository.
          </p>
        </section>
      </div>
    </PublicShell>
  );
}
