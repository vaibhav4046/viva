import { z } from "zod";
import { handle, persist } from "@/lib/redteam/http";
import { markInterrupted, publicView, recordSpokenClaim } from "@/lib/redteam/session";
import { CORRECTION_CUE } from "@/lib/redteam/text";

/**
 * POST /api/redteam/turn — what the browser saw on the socket.
 *
 *  interrupted  the service reported `reply.done` with status "interrupted".
 *               The claim being explained is marked as awaiting a correction.
 *  user_final   a finished user transcript. If a claim is awaiting correction
 *               and the words are a correction, the claim is re-checked now,
 *               without waiting for the agent to decide to call a tool.
 *
 * That second path is why barge-in changes application state even if the
 * language model is slow or forgets: the interruption and the correction are
 * both recorded from protocol events, and the same code the tool uses does the
 * re-check.
 */
const Body = z
  .object({
    sessionId: z.string().max(80),
    event: z.enum(["interrupted", "user_final"]),
    text: z.string().max(2000).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, needsSession: true }, async ({ body, session }) => {
    const s = session!;
    if (s.status === "ended") return Response.json({ changed: false, session: publicView(s) });
    let changed = false;
    let claimId: string | null = null;
    let statusBefore: string | null = null;
    if (body.event === "interrupted") {
      const c = markInterrupted(s);
      changed = true;
      claimId = c?.id ?? null;
    } else if (body.text) {
      const pending = s.claims.find((c) => c.awaitingCorrection);
      if (pending && CORRECTION_CUE.test(body.text)) {
        statusBefore = pending.status;
        const out = recordSpokenClaim(s, { spoken: body.text });
        changed = out.corrected;
        claimId = out.claim.id;
      }
    }
    if (changed) await persist(s);
    return Response.json({ changed, claimId, statusBefore, session: publicView(s) });
  });
}
