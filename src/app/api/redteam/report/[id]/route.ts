import { handle } from "@/lib/redteam/http";
import { buildReport } from "@/lib/redteam/report";

/** GET /api/redteam/report/:id — the report as it stands, ended or not. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(req, { limit: "default", needsSession: true, sessionId: id }, ({ session }) =>
    Response.json({ report: buildReport(session!), ended: session!.status === "ended" })
  );
}
