import { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { compoundMemory } from "@/lib/memory";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";

/** GET /api/learner/review — caller's review queue + compound memory statements. */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["review", clientIp(req)]), "default");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  const store = getStore();
  await store.seedDemoCourse(identity.userId);
  const [queue, concepts, events] = await Promise.all([
    store.getReviewQueue(identity.userId),
    store.getConcepts(identity.userId),
    store.listEvents(identity.userId, 50),
  ]);
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  return done(Response.json({
    queue: queue.map((q) => ({ ...q, conceptName: names.get(q.conceptId) ?? q.conceptId })),
    compound: compoundMemory(events.map((e) => ({
      intent: e.intent,
      primaryConceptId: e.primaryConceptId,
      cleanedTranscript: e.cleanedTranscript,
    }))),
    backend: store.backend,
  }));
}
