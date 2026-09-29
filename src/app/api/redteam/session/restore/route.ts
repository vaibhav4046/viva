import { z } from "zod";
import { handle, persist, reviewFields, sessionGone } from "@/lib/redteam/http";
import { MAX_SNAPSHOT_CHARS, isNewerCopy, openSeal } from "@/lib/redteam/seal";
import { getSession } from "@/lib/redteam/store";

/**
 * POST /api/redteam/session/restore — put a review back after an instance lost it.
 *
 * The browser sends the sealed copy every RedTeam response gave it. If this
 * server sealed it, for this browser, and it is not older than a review lives,
 * the review is saved here and returned, and the call that found it missing can
 * be made again. Anything else, for any reason, is the same 404 a review that
 * never existed gets: the route must not be a way to ask whether a review, an
 * owner or a signature is real.
 *
 * The copy cannot add to or change the ledger. It is only ever a review this
 * server already produced, which is why a restore may be trusted with no
 * database: it saves what the server said, not what the browser says.
 *
 * If this instance already holds a newer copy of the same review (the browser's
 * copy is a step behind, or a restore raced a call), that copy stays and is what
 * comes back, so a restore can never move a review backwards on the instance
 * that is ahead.
 */
const Text = /^[A-Za-z0-9_-]+$/;

const Body = z
  .object({
    snapshot: z
      .object({
        data: z.string().min(1).max(MAX_SNAPSHOT_CHARS).regex(Text),
        sig: z.string().min(1).max(64).regex(Text),
      })
      .strict(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, maxBody: MAX_SNAPSHOT_CHARS + 1_000 }, async ({ userId, body }) => {
    const opened = openSeal(userId, body.snapshot);
    if (!opened) return sessionGone();
    const stored = await getSession(userId, opened.id);
    const kept = stored && !isNewerCopy(opened, stored) ? stored : opened;
    if (kept === opened) await persist(opened);
    return Response.json(reviewFields(kept));
  });
}
