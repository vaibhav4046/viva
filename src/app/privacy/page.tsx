import type { Metadata } from "next";
import { DraftNotice, PublicShell } from "@/components/PublicShell";

/* Rendered per request so the CSP nonce reaches Next's bootstrap scripts (see src/proxy.ts). */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy: VIVA",
  description: "What VIVA stores, where it goes, and how to delete it. Written from the code, not from a template.",
};

/*
 * Written from docs/evidence/data-inventory.md (node scripts/data-inventory.mjs).
 * If the inventory does not show it, this page must not claim it.
 */
export default function PrivacyPage() {
  return (
    <PublicShell>
      <h1 className="heading text-[clamp(1.75rem,1.4rem+1.4vw,2.5rem)]">Privacy</h1>
      <div className="mt-4"><DraftNotice /></div>

      <div className="prose-vv mt-6 space-y-8">
        <section aria-labelledby="p-mic">
          <h2 id="p-mic" className="heading text-xl">Your voice</h2>
          <p>
            During an oral exam your browser opens a WebSocket straight to AssemblyAI&apos;s Voice Agent API
            (agents.assemblyai.com) and streams your microphone audio to it. The connection uses a token our server
            mints for that one session; the AssemblyAI API key never reaches your browser. Dictation on the study
            screen sends a recorded clip to our server, which forwards it to AssemblyAI for transcription.
          </p>
          <p>
            VIVA&apos;s code has no function that writes audio to a database or a file. What AssemblyAI keeps and for how
            long is set by AssemblyAI&apos;s own terms; read them before you use your own material. [NEEDS LEGAL REVIEW]
          </p>
        </section>

        <section aria-labelledby="p-material">
          <h2 id="p-material" className="heading text-xl">Your material and answers</h2>
          <p>
            Notes you upload, paste or point to by URL are split into passages and saved as a subject that belongs to
            your browser identity. Your answers, the source checks made during an exam, your mastery scores and your
            review queue are saved with it. Transcripts of the exam are handled by the app in the same way.
          </p>
          <p>
            Where they are saved depends on the deployment. With a Postgres database configured they are durable.
            Without one, VIVA uses a file store on the server&apos;s temporary disk: it is ephemeral, and it is wiped when
            the server instance restarts or is replaced. <code>/api/health/ready</code> reports which one is running.
            On the hosted hackathon demo, treat storage as ephemeral unless that endpoint says <code>durable: true</code>.
          </p>
        </section>

        <section aria-labelledby="p-llm">
          <h2 id="p-llm" className="heading text-xl">Other companies that see your text</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>AssemblyAI</strong> receives your audio and returns transcripts, as described above.
            </li>
            <li>
              <strong>Language-model providers.</strong> To mark an answer, VIVA sends passages from your material and
              your answer to the model providers in its failover chain, which is set by deployment configuration
              (<code>LLM_BASE_URL</code> and <code>LLM_FALLBACKS</code>). The default in the repository&apos;s
              <code> .env.example</code> is Google&apos;s Gemini through AI Studio. The live chain for this deployment
              must be listed here before a public launch. [NEEDS LEGAL REVIEW]
            </li>
            <li>
              <strong>Vercel</strong> hosts the site and sees ordinary request data (IP address, user agent, URL).
            </li>
            <li>
              <strong>Sites you name.</strong> If you give VIVA a web address, our server fetches that page.
            </li>
          </ul>
        </section>

        <section aria-labelledby="p-cookies">
          <h2 id="p-cookies" className="heading text-xl">Cookies and browser storage</h2>
          <p>
            One cookie: <code>viva_did</code>, a random 128-bit identifier. It is HttpOnly, SameSite=Lax, lasts one
            year, and is marked Secure in production. It is how the server knows which subjects are yours. There is no
            account, no email address and no password.
          </p>
          <p>
            The code loads no analytics, advertising or tracking script and sets no other cookie, so there is no
            cookie banner. [NEEDS LEGAL REVIEW]
          </p>
          <p>
            Your browser&apos;s localStorage holds: the subject you last picked, your conversation notes for each
            subject on the study screen, your spoken-language choice, and a local copy of your learning record so it
            survives a reload. sessionStorage and IndexedDB are not used. Product events are counted in memory for the
            operator (event names and latencies, no text) and are not sent to any third party.
          </p>
        </section>

        <section aria-labelledby="p-retention">
          <h2 id="p-retention" className="heading text-xl">Keeping and deleting</h2>
          <p>
            There is no automatic expiry in the code. Data stays until the store is wiped (ephemeral mode) or you
            delete it. To delete everything tied to your browser identity, open <code>/api/learner?reset=1</code> in
            the browser you used. It erases your subjects, map and notes from the database, or from the file store, and
            answers with an error instead of success if the deletion did not happen. The deletion is not atomic, so if
            you see the error, run it again. It does not clear the copies in your own browser: clear this site&apos;s
            data in your browser settings for that. Deleting a single subject or a single exam separately is not
            built. To ask for deletion another way, use the contact in SECURITY.md in the repository (a placeholder
            until the owner sets a real address).
          </p>
        </section>

        <section aria-labelledby="p-children">
          <h2 id="p-children" className="heading text-xl">Children</h2>
          <p>
            VIVA was built for university students. It makes no claim about being suitable for children and has no age
            check. [NEEDS LEGAL REVIEW]
          </p>
        </section>

        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Source of this page: <code>docs/evidence/data-inventory.md</code>, generated by
          <code> node scripts/data-inventory.mjs</code>.
        </p>
      </div>
    </PublicShell>
  );
}
