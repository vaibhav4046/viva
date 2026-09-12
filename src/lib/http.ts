import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { checkLimit, limitKey } from "@/lib/limits";
import { Trace, rid, serverLog } from "@/lib/observe";
import { getStore, learnerDNA } from "@/lib/store";
import { CONCEPTS, DEMO_SOURCE } from "@/lib/course";
import { compileTranscript } from "@/lib/compiler";
import { tutorRespond, verifyResponse } from "@/lib/tutor";
import { SOURCE_CHUNKS } from "@/lib/course";

/** Attach the demo-identity cookie when freshly minted. */
export function withIdentityCookie(res: Response, setCookie?: string): Response {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
