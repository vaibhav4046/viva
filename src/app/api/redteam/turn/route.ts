import { z } from "zod";
import { handle, persist, reviewFields } from "@/lib/redteam/http";
import { endExplanation, markInterrupted, recordUtterance } from "@/lib/redteam/session";

/**
 * POST /api/redteam/turn — what the browser saw on the socket.
 *
 *  interrupted  the service reported `reply.done` with status "interrupted".
 *               The claim being explained is marked as awaiting a correction.
 *  user_final   a finished user transcript. A correction after a barge-in
 *               re-checks the interrupted claim; a plain statement is recorded
 *               as a claim; talk is ignored. All of it happens now, without
 *               waiting for the agent to decide to call a tool.
 *
 * That second path is why barge-in changes application state even if the
 * language model is slow or forgets: the interruption and the correction are
 * both recorded from protocol events, and the same code the tool uses does the
 * re-check.
 */
const Body = z
  .object({
    sessionId: z.string().max(80),
    event: z.enum(["interrupted", "user_final", "reply_done"]),
    text: z.string().max(2000).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, needsSession: true }, async ({ body, session }) => {
    const s = session!;
    if (s.status === "ended") return Response.json({ changed: false, ...reviewFields(s) });
    let changed = false;
    let claimId: string | null = null;
    let statusBefore: string | null = null;
    let dirty = false;
    if (body.event === "reply_done") {
      // A reply finished without being cut off: whatever it was explaining is over.
      endExplanation(s);
      dirty = true;
    } else if (body.event === "interrupted") {
      const c = markInterrupted(s);
      changed = true;
      claimId = c?.id ?? null;
    } else if (body.text) {
      const pending = s.claims.find((c) => c.awaitingCorrection);
      statusBefore = pending?.status ?? null;
      const out = recordUtterance(s, body.text);
      dirty = true; // what the user said is kept, whether or not it was a claim
      if (out) {
        changed = out.corrected || out.recorded;
        claimId = out.claim.id;
        if (!out.corrected) statusBefore = null;
      }
    }
    if (changed || dirty) await persist(s);
    return Response.json({ changed, claimId, statusBefore, ...reviewFields(s) });
  });
}
