import { NextRequest } from "next/server";
import { findSubjectOwning, resolveSubject } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";

/** POST /api/exam/start — next question, weakest concept first for this user. */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["exam-start", clientIp(req)]), "default");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }
  let conceptId: string | null = null;
  let courseIdIn: string | undefined;
  try {
    const body = (await req.json()) as { conceptId?: string; courseId?: string };
    conceptId = body?.conceptId ?? null;
    courseIdIn = body?.courseId;
  } catch { /* optional */ }
  const store = getStore();
  const course = await resolveSubject(store, identity.userId, courseIdIn);
  const examQuestions = course.examQuestions;
  await store.seedCourse(identity.userId, course.id);
  if (!conceptId) {
    // Adaptive: ask about the caller's weakest tracked concept that has questions.
    const mastery = await store.getMastery(identity.userId);
    const ranked = examQuestions.map((q) => ({ q, m: mastery[q.conceptId]?.mastery ?? 0.5 }))
      .sort((a, b) => a.m - b.m);
    const weakest = ranked[0];
    if (weakest) conceptId = weakest.q.conceptId;
  }
  let activeCourse = course;
  let pool = examQuestions;
  if (conceptId) {
    const scoped = examQuestions.filter((q) => q.conceptId === conceptId);
    if (scoped.length > 0) {
      pool = scoped;
    } else {
      // The concept belongs to another lab (e.g. Today in "all courses" mode):
      // resolve the owning lab instead of answering from the wrong one.
      const owner = await findSubjectOwning(store, identity.userId, conceptId);
      if (owner) {
        await store.seedCourse(identity.userId, owner.id);
        activeCourse = owner;
        const ownerPool = owner.examQuestions.filter((q) => q.conceptId === conceptId);
        pool = ownerPool.length > 0 ? ownerPool : owner.examQuestions;
      }
    }
  }
  if (pool.length === 0) {
    return done(Response.json(
      { error: { code: "NO_QUESTIONS", message: "This course has no exam questions yet.", retryable: false } },
      { status: 400 }
    ));
  }
  const q = pool[Math.floor(Math.random() * pool.length)];
  // courseId lets callers scope the answer POST even in "all courses" mode.
  return done(Response.json({ ...q, courseId: activeCourse.id }));
}
