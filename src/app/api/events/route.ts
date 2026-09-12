import { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";

/** GET /api/events — caller's append-only event history (their data only). */
export async function GET(req: NextRequest) {
  const { identity, setCookie } = await resolveIdentity(req);
  const store = getStore();
  const events = await store.listEvents(identity.userId, 50);
  return withIdentityCookie(Response.json({ events, count: events.length }), setCookie);
}
