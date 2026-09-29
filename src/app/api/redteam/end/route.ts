import { z } from "zod";
import { handle, persist } from "@/lib/redteam/http";
import { finish, publicView } from "@/lib/redteam/session";

/** POST /api/redteam/end — finish the review and build the Defensibility Report. */
const Body = z.object({ sessionId: z.string().max(80) }).strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "exam", schema: Body, needsSession: true }, ({ session }) => {
    const s = session!;
    const report = finish(s);
    persist(s);
    return Response.json({ report, session: publicView(s) });
  });
}
