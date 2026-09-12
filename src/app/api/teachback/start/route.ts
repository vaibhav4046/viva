import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSubject, subjectMissing } from "@/lib/courses/subject";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { clientIp, withIdentityCookie } from "@/lib/http";
import { err } from "@/lib/types";

const Body = z.object({ conceptId: z.string().max(80).optional(), courseId: z.string().max(80).optional() });

/** POST /api/teachback/start — pick a concept (default: caller's weakest with exam coverage) + prompt. */
export async function POST(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);

  const rl = checkLimit(limitKey(["tb-start", clientIp(req)]), "default");
  if (!rl.ok) {
    return done(Response.json(
      { error: { code: "RATE_LIMITED", message: "Slow down a little — try again in a moment.", retryable: true } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    ));
  }

  let conceptId: string | undefined;
  let courseIdIn: string | undefined;
  try {
    const body: unknown = await req.json();
    const p = Body.safeParse(body);
    if (p.success) {
      conceptId = p.data.conceptId;
      courseIdIn = p.data.courseId;
    }
  } catch { /* body optional */ }

  const store = getStore();
  const course = await resolveSubject(store, identity.userId, courseIdIn).catch(subjectMissing);
  if (course instanceof Response) return done(course);
  await store.seedCourse(identity.userId, course.id);
  const [concepts, mastery] = await Promise.all([
    store.getConcepts(identity.userId, course.id),
    store.getMastery(identity.userId),
  ]);
  const byId = new Map(concepts.map((c) => [c.id, c]));
  if (conceptId && !byId.has(conceptId)) {
    return done(err("BAD_REQUEST", "Unknown conceptId.", false, 400));
  }

  if (!conceptId) {
    const covered = new Set(course.examQuestions.map((q) => q.conceptId));
    const ranked = concepts
      .filter((c) => covered.has(c.id))
      .map((c) => ({ id: c.id, m: mastery[c.id]?.mastery ?? 0.5 }))
      .sort((a, b) => a.m - b.m);
    conceptId = ranked[0]?.id ?? concepts[0]?.id;
  }
  if (!conceptId) return done(err("BAD_REQUEST", "No concepts available.", false, 400));
  const concept = byId.get(conceptId);
  if (!concept) return done(err("BAD_REQUEST", "Unknown conceptId.", false, 400));

  const hint = course.teachback.hints[conceptId]
    ?? course.examQuestions.find((q) => q.conceptId === conceptId)?.hint
    ?? `Explain ${concept.name} in your own words.`;

  return done(Response.json({
    conceptId,
    conceptName: concept.name,
    prompt: `Teach me ${concept.name} as though I'm five. 45 seconds.`,
    // requiredKeywords are the answer key: they stay server-side (answer recomputes).
    hint,
  }));
}
