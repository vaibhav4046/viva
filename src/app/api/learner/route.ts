import { NextRequest } from "next/server";
import { getStore, learnerDNA } from "@/lib/store";
import { listSubjectsFor, resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";

/**
 * GET /api/learner?courseId=… — scoped mastery + learner DNA + recent events.
 * ?reset=1 deletes ONLY the caller's data (privacy §110).
 *
 * A learner who has never spoken gets an empty `mastery` and an empty
 * `events`. The subject's own material (concepts, passages, questions) is
 * still there — the map can show six concepts at "Not yet" without claiming
 * anybody answered anything.
 */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);
  const store = getStore();
  if (req.nextUrl.searchParams.get("reset") === "1") {
    await store.deleteUserData(identity.userId);
  }
  const courseParam = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const course = await resolveSubject(store, identity.userId, courseParam).catch(subjectMissing);
  if (course instanceof Response) return done(course);
  await store.seedCourse(identity.userId, course.id);
  const [allMastery, allEvents, concepts] = await Promise.all([
    store.getMastery(identity.userId),
    store.listEvents(identity.userId, 20),
    store.getConcepts(identity.userId, course.id),
  ]);
  // Scoped when ?courseId= is explicit: only this lab's concepts and events.
  const conceptIds = new Set(concepts.map((c) => c.id));
  const mastery = courseParam
    ? Object.fromEntries(Object.entries(allMastery).filter(([id]) => conceptIds.has(id)))
    : allMastery;
  const events = courseParam ? allEvents.filter((e) => e.courseId === course.id) : allEvents;
  // Always empty now, and kept only so an older client does not crash on a
  // missing key. Nothing about this learner is pre-filled: a concept with no
  // record is "Not yet", which is the truth on a first visit.
  const priors: Record<string, number> = {};
  const productEvents = await store.productEventSummary(identity.userId, 7);
  return done(Response.json({
    mastery, events, concepts, priors,
    courses: await listSubjectsFor(store, identity.userId),
    productEvents,
    activeCourseId: course.id,
    learner: learnerDNA(mastery, events.filter((e) => e.intent === "confusion").map((e) => e.id), events.length),
    backend: store.backend,
  }));
}
