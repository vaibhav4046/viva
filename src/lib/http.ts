/** Attach the demo-identity cookie when freshly minted. */
export function withIdentityCookie(res: Response, setCookie?: string): Response {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

/**
 * Who to charge this request to.
 *
 * `x-forwarded-for` is a list the caller gets to start: whatever they send
 * arrives as the leftmost entries and each proxy appends the address it
 * actually saw. Reading `[0]` therefore read a value the attacker chose, so
 * rotating one header handed out a fresh token bucket per request — including
 * on the endpoints that spend the AssemblyAI balance and the model key. The
 * last entry is the one the nearest trusted hop wrote, so take that. An empty
 * header is nobody, not a shared bucket named "".
 *
 * `x-vercel-forwarded-for` is better still — the platform writes it and a
 * caller cannot — but only where that platform is in front. `next start` is a
 * path this repo ships, and there nothing sets it, so honouring it
 * unconditionally would only move the spoof to a header with a nicer name.
 *
 * Takes a plain `Request` because the routes that spend the AssemblyAI balance
 * are plain-`Request` handlers, and a helper the money paths cannot call is a
 * helper that gets copied badly. `NextRequest` is a `Request`, so every other
 * caller is unaffected.
 *
 * ponytail: one trusted hop assumed off Vercel. Behind proxies of your own,
 * take the Nth from the right for that depth.
 */
export function clientIp(req: Request): string {
  const platform = process.env.VERCEL ? req.headers.get("x-vercel-forwarded-for") : null;
  const chain = platform ?? req.headers.get("x-forwarded-for") ?? "";
  return chain.split(",").pop()?.trim() || "unknown";
}
