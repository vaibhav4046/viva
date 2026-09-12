/** GET /api/health — liveness. App process works. No dependencies, no secrets. */
export async function GET() {
  return Response.json({ ok: true, service: "viva", version: "0.2.0", uptimeSec: Math.round(process.uptime()) });
}
