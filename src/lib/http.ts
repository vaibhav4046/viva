import { NextRequest } from "next/server";

/** Attach the demo-identity cookie when freshly minted. */
export function withIdentityCookie(res: Response, setCookie?: string): Response {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
