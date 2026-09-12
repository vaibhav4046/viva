import { NextRequest } from "next/server";
import { getStore, learnerDNA } from "@/lib/store";
import { listSubjectsFor, resolveSubject } from "@/lib/courses/subject";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { buildSeedDoc } from "@/lib/store/seed";

/**
 * GET /api/learner?courseId=… — scoped mastery + learner DNA + recent events.
 * ?reset=1 deletes ONLY the caller's data and reseeds (privacy §110).
 * `priors` labels every seeded track honestly (demo data, not measured).
 */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);
  const store = getStore();
  if (req.nextUrl.searchParams.get("reset") === "1") {
    await store.deleteUserData(identity.userId);
  }
  const courseParam = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const course = await resolveSubject(store, identity.userId, courseParam);
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
  const priors: Record<string, number> = {};
  if (course.demo) {
    for (const [id, m] of Object.entries(buildSeedDoc(identity.userId).mastery)) {
      if (!courseParam || conceptIds.has(id)) priors[id] = m.mastery;
    }
  }
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
