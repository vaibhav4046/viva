import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/PublicShell";
import { RecordedPlayer } from "@/components/RecordedPlayer";
import { loadRecording, loadRecordingIndex, recordingDateLabel } from "@/lib/recordings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Watch a recorded exam: VIVA",
  description: "A recorded VIVA oral exam with audio, transcript and source checks. No microphone needed.",
};

export default async function RecordedPage() {
  const latest = await loadRecordingIndex();
  const session = latest ? await loadRecording(latest.id) : null;

  return (
    <PublicShell width="wide">
      <h1 className="heading text-[clamp(1.75rem,1.4rem+1.4vw,2.5rem)]">Watch a recorded exam</h1>

      {session ? (
        <>
          <p className="mt-3 max-w-[68ch]" style={{ color: "var(--text-secondary)" }}>
            Recorded session, <span className="mono">{recordingDateLabel(session.recordedAt)}</span>, synthetic learner
            voice. The examiner audio and every source check come from a live session. Course: {session.course}.
          </p>
          <div className="mt-6">
            <RecordedPlayer session={session} />
          </div>
        </>
      ) : (
        <div className="surface-card mt-6 max-w-xl p-5" role="status">
          <h2 className="heading text-xl">No recording is published yet</h2>
          <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
            The recorded session is produced from a live exam with a synthetic learner voice, and it has not been
            added to this build. Until it is, you can run the sample exam yourself with a microphone or by typing.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/oral?subjectId=course_transformers_w4" className="btn-primary">Try a sample exam</Link>
            <Link href="/" className="btn-ghost">Back to the start</Link>
          </div>
        </div>
      )}
    </PublicShell>
  );
}
