import { NextRequest } from "next/server";
import { getCourse } from "@/lib/courses";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";

/** GET /api/sources?courseId=… — requested lab's seeded content (labeled) + caller uploads. */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const course = getCourse(req.nextUrl.searchParams.get("courseId"));
  const store = getStore();
  await store.seedCourse(identity.userId, course.id);
  const [chunks, concepts] = await Promise.all([
    store.getCourseChunks(identity.userId, course.id),
    store.getConcepts(identity.userId, course.id),
  ]);
  const first = course.sources[0];
  return withIdentityCookie(Response.json({
    course: { id: course.id, code: course.code, title: course.title, subject: course.subject, demo: true },
    source: first
      ? { id: first.id, courseId: course.id, title: first.title, type: first.type }
      : null,
    chunks,
    concepts,
  }), setCookie);
}
