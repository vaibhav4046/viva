import { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
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
  const param = req.nextUrl.searchParams.get("subjectId") ?? req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const subject = await resolveSubject(store, identity.userId, param).catch(subjectMissing);
  if (subject instanceof Response) return done(subject);
  await store.seedCourse(identity.userId, subject.id);
  const [queue, concepts, allEvents] = await Promise.all([
    store.getReviewQueue(identity.userId),
    store.getConcepts(identity.userId, subject.id),
    store.listEvents(identity.userId, 50),
  ]);
  const names = new Map(concepts.map((c) => [c.id, c.name]));
  // Scoped when a subject was named: this subject's concepts and its own turns.
  const conceptIds = new Set(concepts.map((c) => c.id));
  const events = param ? allEvents.filter((e) => e.courseId === subject.id) : allEvents;
  return done(Response.json({
    subjectId: subject.id,
    queue: queue
      .filter((q) => !param || conceptIds.has(q.conceptId))
      .map((q) => ({ ...q, conceptName: names.get(q.conceptId) ?? q.conceptId })),
    compound: compoundMemory(
      events.map((e) => ({
        intent: e.intent,
        primaryConceptId: e.primaryConceptId,
        cleanedTranscript: e.cleanedTranscript,
      })),
      Object.fromEntries(names)
    ),
    backend: store.backend,
  }));
}
