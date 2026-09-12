import Link from "next/link";
import { headers } from "next/headers";
import { Keyboard, Mic, Sparkles } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { VoiceOrbMount } from "@/components/VoiceOrbMount";
import "./landing.css";

/*
 * VIVA landing.
 *
 * A server component with no framework runtime of its own: the hero is static
 * markup plus landing.css, and the only client JavaScript is the few hundred
 * bytes of IntersectionObserver behind the three rows below the fold. No
 * video, no stock stills, no stat row — every number that used to sit here
 * ("0.956 confidence", "182 ms", "140 tests") was a claim about us rather than
 * a promise to the reader.
 *
 * Rendered per request on purpose. Reading the nonce set by src/proxy.ts is
 * what marks this route dynamic, and only a dynamically rendered document gets
 * Next's bootstrap scripts stamped with that nonce. Prerender it and the page's
 * own `script-src 'strict-dynamic'` policy blocks every chunk it ships — the
 * hero renders and nothing hydrates.
 *
 * scripts/e2e-golden.py pins: an element with id="hero", the string
 * "VIVA REMEMBERS" inside it, and a link named "Bring your own subject" that
 * routes to /subjects. Keep all three when editing copy.
 */

const ROWS = [
  {
    Icon: Mic,
    title: "Speak",
    body:
      "Hold the mic and think out loud. Your words come back in under a second, cleaned of the ums and false starts, with the hedges left exactly as you said them.",
    aside: "Cleaned by AssemblyAI",
  },
  {
    Icon: Sparkles,
    title: "Get asked",
    body:
      "VIVA confirms what you got right, names the one thing you got wrong, quotes the passage that shows it, and asks the question that makes you work it out yourself.",
    aside: "Every correction cites your source",
  },
  {
    Icon: Keyboard,
    title: "Come back tomorrow",
    body:
      "What you were shaky on becomes a ten-minute plan for the next day. You answer out loud again, and the map moves.",
    aside: "Ten minutes, built from yesterday",
  },
] as const;

export const metadata = {
  title: "VIVA · Study out loud",
};

export default async function Home() {
  // Marks the route dynamic; see the note above. The value itself is unused.
  await headers();

  return (
    <div className="vv-page">
      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="vv-hero">
          <div className="vv-glow" aria-hidden />
          <div className="vv-hero-inner" id="hero">
            <VoiceOrbMount className="vv-orb" />
            <h1 className="vv-headline">
              <span className="vv-dot">STUDY OUT LOUD.</span>
              <span className="vv-dot">VIVA REMEMBERS.</span>
            </h1>

            <p className="vv-sub">
              Talk through what you&apos;re learning. VIVA catches what you got wrong, asks the one question that fixes
              it, and quizzes you tomorrow.
            </p>

            <div className="vv-cta-row">
              <Link href="/study" className="btn-primary">
                <Mic size={17} aria-hidden />
                Start talking
              </Link>
              <Link
                href="/subjects"
                className="min-h-11 self-center px-2 text-base underline underline-offset-4"
                style={{ color: "var(--color-mist)" }}
              >
                Bring your own subject
              </Link>
            </div>
          </div>
          <p className="vv-scroll-hint" aria-hidden>
            How it works
          </p>
        </section>

        {/* ------------------------------------------------- how it works */}
        <section aria-label="How it works" className="mx-auto max-w-3xl px-5 pb-24 pt-8">
          <ul className="space-y-5">
            {ROWS.map(({ Icon, title, body, aside }, i) => (
              <li key={title}>
                <Reveal delayMs={i * 60}>
                  <article className="surface-card flex gap-4 p-6">
                    <span
                      aria-hidden
                      className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border hairline"
                      style={{ color: "var(--color-cognition)" }}
                    >
                      <Icon size={17} />
                    </span>
                    <div className="min-w-0">
                      <h2 className="heading text-xl">{title}</h2>
                      <p className="prose-measure mt-2 leading-relaxed" style={{ color: "var(--color-mist)" }}>
                        {body}
                      </p>
                      <p className="mono mt-3 text-xs" style={{ color: "var(--color-ash)" }}>
                        {aside}
                      </p>
                    </div>
                  </article>
                </Reveal>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t hairline">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm">
          <p style={{ color: "var(--color-ash)" }}>Built with AssemblyAI Dictation API</p>
          <a
            href="https://github.com/vaibhav4046/viva"
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11 self-center underline underline-offset-4"
            style={{ color: "var(--color-mist)" }}
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
