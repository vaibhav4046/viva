import { NextRequest } from "next/server";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";

/** GET /api/sources?courseId=… — requested lab's seeded content (labeled) + caller uploads. */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const store = getStore();
  const param = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  const course = await resolveSubject(store, identity.userId, param).catch(subjectMissing);
  if (course instanceof Response) return withIdentityCookie(course, setCookie);
  await store.seedCourse(identity.userId, course.id);
  const [chunks, concepts] = await Promise.all([
    store.getCourseChunks(identity.userId, course.id),
    store.getConcepts(identity.userId, course.id),
  ]);
  const first = course.sources[0];
  /*
   * `source` is the first one, which is what the reader has always shown. A
   * subject can now be composed of several documents — a lecture PDF, a page
   * from the module site, the student's own notes — and a passage cites the
   * document it is actually in, so the whole list travels too, each with the
   * licence it was taken under. Showing that attribution is the condition on
   * using openly licensed material at all, so it cannot be optional here.
   */
  const sources = course.sources.map((s) => ({
    id: s.id,
    courseId: course.id,
    title: s.title,
    type: s.type,
    url: s.url ?? null,
    licence: s.licence ?? null,
  }));
  return withIdentityCookie(Response.json({
    course: { id: course.id, code: course.code, title: course.title, subject: course.subject, demo: course.demo },
    source: first ? sources[0] : null,
    sources,
    chunks,
    concepts,
  }), setCookie);
}
