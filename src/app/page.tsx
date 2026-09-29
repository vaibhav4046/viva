import Link from "next/link";
import { headers } from "next/headers";
import { SampleExamButton } from "@/components/SampleExamButton";
import { CorrectionMark, PassageCard, QuestionCard, StateLine } from "@/components/ui/exam";
import { MarkIcon } from "@/components/ui/icons";
import { EXCERPT } from "@/lib/fixtures/excerpt";
import { loadRecordingIndex } from "@/lib/recordings";
import "./landing.css";

/*
 * VIVA front door.
 *
 * A server component with no client JavaScript of its own except the one button
 * that selects the sample course. Rendered per request on purpose: reading the
 * nonce set by src/proxy.ts is what marks this route dynamic, and only a
 * dynamically rendered document gets Next's bootstrap scripts stamped with it.
 * Prerender it and `script-src 'strict-dynamic'` blocks every chunk.
 *
 * Composition: the left column says what the product does and starts it, the
 * right column shows it doing that with the real components (state line,
 * question card, correction mark, passage card). Nothing here is a claim the
 * excerpt does not show. Only numbers present in numbers.json may appear in
 * copy; none exist yet, so there is no evidence strip.
 */

/** The internal passage id stays in the fixture for the test; a reader sees the page number and section. */
const { passageId: _internalId, ...visiblePassage } = EXCERPT.passage;

export const metadata = {
  title: "VIVA: an oral exam on your own lecture notes",
};

export default async function Home() {
  // Marks the route dynamic; see the note above. The value itself is unused.
  await headers();
  const recording = await loadRecordingIndex();

  return (
    <div className="vv-page">
      <header className="vv-top">
        <Link href="/" className="vv-brand" aria-label="VIVA home">
          <MarkIcon size={22} />
          <span className="heading">VIVA</span>
        </Link>
        <nav aria-label="Start" className="vv-top-nav">
          <Link href="/oral" className="nav-link">Oral exam</Link>
          <Link href="/subjects" className="nav-link">Your material</Link>
          <Link href="/recorded" className="nav-link">Watch a recording</Link>
        </nav>
      </header>

      <main id="main">
        <section className="vv-fold" id="hero" aria-labelledby="vv-h1">
          <div className="vv-copy">
            <h1 id="vv-h1" className="vv-h1">
              Upload your lecture notes. Get examined on them out loud.
            </h1>
            <p className="vv-lede">
              VIVA asks you questions, listens to your answers, checks them against your own pages, and tells you what to revise tomorrow.
            </p>
            <p className="vv-who">
              For students who can recognise the right answer on the page but have not yet tried to explain it aloud.
            </p>

            <div className="vv-cta">
              <SampleExamButton />
              <Link href="/subjects" className="btn-ghost">
                Use your own material
              </Link>
            </div>
            <p className="vv-note">
              Use headphones in a quiet room. Your browser will ask for the microphone, and you can type your answers instead.
              The sample exam is on VIVA&apos;s own Transformers notes, so you need no upload.
            </p>
            <p className="vv-note">
              No microphone?{" "}
              <Link href="/recorded" className="link">
                Watch a recorded exam
              </Link>
              .
            </p>
          </div>

          <figure className="vv-excerpt" aria-label="Excerpt of an exam session">
            <div className="vv-excerpt-head">
              <span className="eyebrow">{EXCERPT.course}</span>
              <StateLine>{EXCERPT.stateLine}</StateLine>
            </div>

            <QuestionCard>{EXCERPT.question}</QuestionCard>

            <div className="vv-turn">
              <p className="eyebrow">You</p>
              <p className="vv-learner">
                It loses track of <CorrectionMark>{EXCERPT.learnerWrong}</CorrectionMark>, so the ranking of relevance is gone.
              </p>
            </div>

            <PassageCard {...visiblePassage} />

            <div className="vv-turn">
              <p className="eyebrow">Examiner</p>
              <p className="vv-examiner">{EXCERPT.correction}</p>
            </div>

            <figcaption className="vv-caption">
              {recording ? (
                <>
                  Recorded session, {recording.recordedAtLabel}, synthetic learner voice.{" "}
                  <Link href="/recorded" className="link">Play it</Link>.
                </>
              ) : (
                <>
                  Scripted excerpt built from the sample course. The learner line is written, not recorded. The examiner
                  reply shows the shape of a real one.
                </>
              )}
            </figcaption>
          </figure>
        </section>

        <section className="vv-run" aria-labelledby="vv-run-h">
          <h2 id="vv-run-h" className="heading vv-h2">What happens in a session</h2>
          <ol className="vv-steps">
            <li>
              <span className="vv-step-n mono" aria-hidden>1</span>
              <div>
                <h3 className="vv-h3">You load material</h3>
                <p>Pick the sample course, or upload your own notes. After an upload, VIVA shows how many concepts, questions and passages it found before you start.</p>
              </div>
            </li>
            <li>
              <span className="vv-step-n mono" aria-hidden>2</span>
              <div>
                <h3 className="vv-h3">The examiner asks, you answer aloud</h3>
                <p>When you say something the pages contradict, VIVA looks up the passage, reads you the line, and names the page. A quoted line is accepted only if it appears word for word in your material.</p>
              </div>
            </li>
            <li>
              <span className="vv-step-n mono" aria-hidden>3</span>
              <div>
                <h3 className="vv-h3">You leave with a sheet</h3>
                <p>A debrief lists which concepts were strong, shaky or weak with the answers behind each mark, the misconceptions caught against your pages, and a plan for what to revise tomorrow. You can print it or save it as a PDF.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="vv-limits" aria-labelledby="vv-limits-h">
          <h2 id="vv-limits-h" className="heading vv-h2">Who this is not for</h2>
          <p>
            VIVA reads text. A scan with no text layer gives it nothing to quote. It cannot tell you your notes are
            right, only whether your answer matches them. It is a hackathon build, and your microphone audio goes to
            AssemblyAI while an exam runs. The{" "}
            <Link href="/privacy" className="link">privacy page</Link> lists what is stored and where.
          </p>
        </section>
      </main>
    </div>
  );
}
