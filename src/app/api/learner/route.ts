import { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { subjectMissing } from "@/lib/courses/subject";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { learnerSnapshot } from "@/lib/sync";
import { err } from "@/lib/types";

/**
 * GET /api/learner?subject=… — scoped mastery, recent notes, and this
 * learner's subjects. ?reset=1 deletes ONLY the caller's data (privacy §110).
 *
 * A learner who has never spoken gets an empty `mastery` and an empty
 * `events`. The subject's own material (concepts, passages, questions) is
 * still there — the map can show six concepts at "Not yet" without claiming
 * anybody answered anything.
 *
 * The payload is built by `learnerSnapshot`, the same function behind
 * POST /api/learner/sync, so a plain read and a reconciled read cannot
 * disagree about the same student.
 */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const done = (res: Response) => withIdentityCookie(res, setCookie);
  const store = getStore();
  if (req.nextUrl.searchParams.get("reset") === "1") {
    try {
      await store.deleteUserData(identity.userId);
    } catch {
      // A student asked to be forgotten and was not. Loud is right — the
      // silent version told them yes and kept the rows — but a bare 500 is
      // loud at the wrong person: every other route here answers with a coded
      // body and a sentence, so this one does too. The sentence does not
      // promise how much survived, because the delete is not atomic (see
      // DESTRUCTIVE in src/lib/store/index.ts, which clears the ephemeral copy
      // before the durable one); it promises only that the answer is no.
      return done(
        err(
          "RESET_FAILED",
          "VIVA could not erase your subjects, your map and your notes just now. Not all of it is gone — try again in a moment.",
          true,
          503
        )
      );
    }
  }
  const courseParam = req.nextUrl.searchParams.get("subject") ?? req.nextUrl.searchParams.get("courseId");
  try {
    return done(Response.json(await learnerSnapshot(store, identity.userId, courseParam)));
  } catch (error) {
    return done(subjectMissing(error));
  }
}
