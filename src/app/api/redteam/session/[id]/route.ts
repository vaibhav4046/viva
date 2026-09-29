import { handle, reviewFields } from "@/lib/redteam/http";
import { buildVoiceConfig } from "@/lib/redteam/prompt";
import { deleteSession } from "@/lib/redteam/store";
import { err } from "@/lib/types";

/** GET — the session as it stands, for a reload. DELETE — forget it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(req, { limit: "default", needsSession: true, sessionId: id }, ({ session }) => {
    const s = session!;
    const last = s.challenges.at(-1)?.question;
    const voice = buildVoiceConfig(s);
    // A resumed review must not replay its opening line as though it were new.
    voice.greeting = last ? `Picking up where we left off. ${last}` : "Picking up where we left off.";
    return Response.json({ ...reviewFields(s), voice });
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(req, { limit: "default", needsSession: true, sessionId: id }, async ({ userId }) =>
    (await deleteSession(userId, id)) ? Response.json({ ok: true }) : err("SESSION_NOT_FOUND", "That review is not here any more.", false, 404)
  );
}
