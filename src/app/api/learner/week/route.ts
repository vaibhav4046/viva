import { NextRequest } from "next/server";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { projectWeek } from "@/lib/planner";

/**
 * GET /api/learner/week — deterministic 7-day projection ("Your week").
 *
 * Derived from the caller's real stored state: today is exactly the Daily Path
 * (GET /api/learner/path), queue items land on their stored due day per the
 * review-priority spacing rule, and the remaining ranked candidates escalate
 * one free future day at a time. Same planner module as the path — no second
 * scheduler, no LLM.
 *
 * `userId` is the resolved identity (cookie/Privy); there is deliberately no
 * user-switching query parameter (see src/lib/auth/identity.ts §15).
 * `?courseId=` scopes the projection to one lab; absent = all labs.
 */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const store = getStore();
  const courseParam = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const course = await resolveSubject(store, identity.userId, courseParam).catch(subjectMissing);
  if (course instanceof Response) return done(course);
  await store.seedCourse(identity.userId, course.id);
  const [allMastery, allEvents, allQueue, concepts] = await Promise.all([
    store.getMastery(identity.userId),
    store.listEvents(identity.userId, 50),
    store.getReviewQueue(identity.userId),
    store.getConcepts(identity.userId, course.id),
  ]);
  const conceptIds = new Set(concepts.map((c) => c.id));
  const mastery = courseParam
    ? Object.fromEntries(Object.entries(allMastery).filter(([id]) => conceptIds.has(id)))
    : allMastery;
  const events = courseParam ? allEvents.filter((e) => e.courseId === course.id) : allEvents;
  const queue = courseParam ? allQueue.filter((q) => conceptIds.has(q.conceptId)) : allQueue;

  const week = projectWeek({ mastery, events, queue, concepts }, new Date());

  return done(Response.json(week));
}
