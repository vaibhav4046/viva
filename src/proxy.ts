import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 Proxy (the `middleware` convention is deprecated — see
 * node_modules/next/dist/docs/…/content-security-policy.md and proxy.md).
 *
 * CSP with a per-request nonce:
 * - The nonce is generated per request (128-bit base64) and set on the REQUEST
 *   as `x-nonce` and `Content-Security-Policy` so the App Router renderer
 *   attaches it to its own inline bootstrap scripts and framework chunks.
 * - The same policy is set on the RESPONSE so the browser enforces it.
 * - `style-src` keeps `'unsafe-inline'` on purpose: React's `style={{…}}`
 *   prop writes inline styles and there is no nonce path for them. (This
 *   note used to blame GSAP and Framer Motion; both were removed and the
 *   justification for a loosened directive should never outlive its cause.)
 * - `connect-src` is 'self' plus Vercel insights, and nothing else: the
 *   browser's only egress is this origin, because every provider call is made
 *   server-side.
 * - `frame-ancestors 'none'` + `object-src 'none'` + `base-uri 'self'` close
 *   clickjacking, plugin and base-tag injection in one header.
 *
 */

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  /*
   * One policy for every route, no `'unsafe-inline'` escape hatch.
   *
   * This used to carry a STATIC_PAGES exemption: a prerendered document's
   * inline bootstrap is generated before any request exists, so no nonce can
   * be attached and a nonce policy blocks the page's own scripts. That set
   * went stale the moment routes were renamed, and the result was severe —
   * `/` and `/study` painted and then never hydrated, with a dozen CSP errors
   * per load, because they were prerendered but served the nonce policy.
   *
   * The fix is upstream: every page is dynamically rendered on purpose (the
   * landing awaits headers(), the app group sets force-dynamic), so Next
   * stamps its own bootstrap with this nonce and `'strict-dynamic'` holds
   * everywhere. If you ever make a route static again, it will break loudly —
   * that is the intent. Do not reintroduce an allowlist; make the page dynamic.
   */
  const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`;

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // One provider origin, and only because a WebSocket leaves no alternative.
    //
    // Every batch call is still server-side: /api/voice/transcribe posts the
    // clip, /api/voice/warm exists precisely so the browser never reaches
    // AssemblyAI for that path, and no HTTPS origin of theirs is listed here.
    // Live streaming is the exception. Relaying a socket through a Next route
    // would put a server hop in front of every 64 ms audio frame and every
    // partial word, which is the exact latency streaming exists to remove, so
    // the browser opens the socket itself. What it carries is a short-lived
    // streaming-only token from /api/voice/stream-token, never the API key.
    //
    // Scoped as tightly as the mechanism allows: the exact host, and `wss:`
    // only — an injected script gets a WebSocket to AssemblyAI's streaming
    // endpoint and no new fetch target anywhere.
    "connect-src 'self' https://*.vercel-insights.com wss://streaming.assemblyai.com",
    "frame-src 'none'",
    // The mic capture path loads an AudioWorklet module from a blob: URL.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except:
     * - _next/static, _next/image (build assets — no CSP needed, avoids 431s)
     * - favicon.ico, brand/ (static public assets)
     * and except prefetch requests (they never render a document).
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico|brand/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
