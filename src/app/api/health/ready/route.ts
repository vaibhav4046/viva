import { dbStatus } from "@/lib/db/db";
import { storeDegradation } from "@/lib/store";
import { providerStatus } from "@/lib/ai/provider";
import { resolveTranscriptionMode } from "@/lib/assemblyai";

/**
 * GET /api/health/ready — readiness. Reports whether critical dependencies
 * are reachable. Never exposes secrets or counts a missing optional dep
 * as a lie: each dependency reports configured/reachable explicitly.
 */
export async function GET() {
  /*
   * Report the mode the hot path will actually use, not the raw env string.
   * This probe used to echo ASSEMBLYAI_TRANSCRIPTION_MODE verbatim and default
   * it to "sync", while the provider resolves aliases and defaults to
   * "dictation" — so the one endpoint whose job is honest disclosure could
   * name a different endpoint than the one serving traffic.
   */
  const transcription = process.env.ASSEMBLYAI_API_KEY
    ? { configured: true, mode: resolveTranscriptionMode() }
    : { configured: false, mode: null };
  const database = await dbStatus();
  const store = storeDegradation();
  // Not part of `degraded`: an unset model is a quieter tutor, not an outage.
  const provider = providerStatus();

  /*
   * Two separate questions, deliberately not merged:
   *
   *   ready   — can this instance serve a request? getStore() always has the
   *             in-process file store to fall back to, so once we are far
   *             enough to answer at all, the answer is yes. Returning 503 here
   *             because the durable backend is down would take a working demo
   *             offline and is its own kind of lie.
   *   durable — will a write survive a redeploy or a new instance? This is the
   *             field that goes false, and it is the one that matters.
   *
   * Collapsing these is what produced the original bug: a probe that reported
   * a healthy store while every write path returned 500.
   */
  const degraded = store.degraded || !database.durable;

  return Response.json(
    {
      ready: true,
      durable: database.durable && !store.degraded,
      degraded,
      transcription,
      provider,
      database,
      store: store.degraded
        ? { mode: "ephemeral-fallback", from: store.from, reason: store.reason, since: store.since }
        : { mode: database.durable ? "durable" : "ephemeral" },
      ts: new Date().toISOString(),
    },
    { status: 200 }
  );
}
