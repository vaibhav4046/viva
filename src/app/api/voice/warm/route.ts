/**
 * GET /api/voice/warm — wake the dictation service before the audio exists.
 *
 * The upstream warm endpoint needs no auth, but it is still proxied so the
 * browser never learns a provider hostname it does not otherwise talk to, and
 * so the CSP connect-src stays 'self' for this call.
 *
 * Always 204. This is a hint, not a dependency: if warming fails the real
 * request still works, it is just a little slower, and the learner must never
 * see a failure for something they did not ask for.
 */

const WARM_URL = process.env.ASSEMBLYAI_WARM_URL ?? "https://dictation.assemblyai.com/warm";

export async function GET(): Promise<Response> {
  try {
    await fetch(WARM_URL, { method: "GET", signal: AbortSignal.timeout(2000), cache: "no-store" });
  } catch {
    // Deliberately swallowed: see above. Nothing downstream depends on this.
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
