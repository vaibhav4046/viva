import { z } from "zod";
import { handle, persist } from "@/lib/redteam/http";
import { askNext, markInterrupted, publicView, recordSpokenClaim } from "@/lib/redteam/session";

/**
 * POST /api/redteam/typed — the typed fallback.
 *
 * When there is no microphone, no key, or no network to the voice service, the
 * same review runs on typed answers. It goes through exactly the same ledger
 * and the same claim engine as the voice path, and the screen labels it
 * "Typed" so it is never mistaken for the Voice Agent. `interrupt` is the typed
 * equivalent of cutting in.
 */
const Body = z
  .object({
    sessionId: z.string().max(80),
    text: z.string().max(1000).optional(),
    interrupt: z.boolean().optional(),
    next: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, needsSession: true }, ({ body, session }) => {
    const s = session!;
    let claimId: string | null = null;
    let previous: string | null = null;
    let corrected = false;
    if (body.interrupt) markInterrupted(s);
    if (body.text?.trim()) {
      const out = recordSpokenClaim(s, { spoken: body.text });
      claimId = out.claim.id;
      previous = out.previousStatus;
      corrected = out.corrected;
    }
    if (body.next) askNext(s);
    persist(s);
    return Response.json({ claimId, previousStatus: previous, corrected, session: publicView(s) });
  });
}
