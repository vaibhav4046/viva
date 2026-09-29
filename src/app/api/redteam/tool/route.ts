import { z } from "zod";
import { handle, persist } from "@/lib/redteam/http";
import { publicView } from "@/lib/redteam/session";
import { runTool } from "@/lib/redteam/tools";

/**
 * POST /api/redteam/tool — run one Voice Agent tool call.
 *
 * The browser relays `tool.call` here and sends the result back on
 * `reply.done`. The tool runs against the caller's own session only; the
 * response carries the updated ledger so the Defensibility Map renders from
 * the server's state, not from anything the browser computed.
 */
const Body = z
  .object({
    sessionId: z.string().max(80),
    callId: z.string().max(200).optional(),
    name: z.string().max(80),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, needsSession: true }, ({ body, session }) => {
    const s = session!;
    const out = runTool(s, body.name, body.arguments ?? {});
    if (out.changed) persist(s);
    return Response.json({ result: out.result, isError: out.isError, session: publicView(s) });
  });
}
