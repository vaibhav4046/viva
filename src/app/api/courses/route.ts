import { getCourse, listCourses } from "@/lib/courses";

/**
 * GET /api/courses — public lab metadata for pickers (no identity required,
 * no chunk bodies). Counts are structural facts from the course registry.
 */
export async function GET() {
  const courses = listCourses().map((c) => {
    const course = getCourse(c.id);
    return {
      id: course.id,
      code: course.code,
      title: course.title,
      subject: course.subject,
      conceptCount: course.concepts.length,
      chunkCount: course.sources.reduce((n, s) => n + s.chunks.length, 0),
      examCount: course.examQuestions.length,
      trapCount: course.traps.length,
    };
  });
  return Response.json({ courses });
}
