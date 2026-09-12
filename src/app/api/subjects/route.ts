import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { listSubjectsFor } from "@/lib/courses/subject";
import { withIdentityCookie } from "@/lib/http";
import { getStore } from "@/lib/store";

/**
 * GET /api/subjects — the starters we ship plus the caller's own subjects.
 * Scoped to the cookie identity: another browser's subjects are not listed
 * and cannot be opened.
 */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const subjects = await listSubjectsFor(getStore(), identity.userId);
  // `courses` is the name the picker already reads; both keys carry the same list.
  return withIdentityCookie(Response.json({ subjects, courses: subjects }), setCookie);
}
