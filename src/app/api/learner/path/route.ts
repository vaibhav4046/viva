import { NextRequest } from "next/server";
import { resolveSubject } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { selectDailyPath } from "@/lib/planner";

/**
 * GET /api/learner/path — deterministic 10-minute Daily Path (§15, §61-63).
 *
 * NO LLM: the composition rules are a pure fold over the caller's own mastery,
 * last 50 events and review queue. Identical inputs produce an identical path.
 * The single scheduler lives in src/lib/planner.ts (also used by
 * GET /api/learner/week); this route only scopes the caller's stored state.
 */

export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const store = getStore();
  const courseParam = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const course = await resolveSubject(store, identity.userId, courseParam);
  await store.seedCourse(identity.userId, course.id);
  const [allMastery, allEvents, allQueue, concepts] = await Promise.all([
    store.getMastery(identity.userId),
    store.listEvents(identity.userId, 50),
    store.getReviewQueue(identity.userId),
    store.getConcepts(identity.userId, course.id),
  ]);
  // Explicit ?courseId= scopes the fold to one lab; absent = all labs.
  const conceptIds = new Set(concepts.map((c) => c.id));
  const mastery = courseParam
    ? Object.fromEntries(Object.entries(allMastery).filter(([id]) => conceptIds.has(id)))
    : allMastery;
  const events = courseParam ? allEvents.filter((e) => e.courseId === course.id) : allEvents;
  const queue = courseParam ? allQueue.filter((q) => conceptIds.has(q.conceptId)) : allQueue;

  const path = selectDailyPath({ mastery, events, queue, concepts });

  return done(
    Response.json({
      path,
      generatedAt: new Date().toISOString(),
      basis: { events: events.length, concepts: Object.keys(mastery).length },
    })
  );
}
