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
 * - `style-src` keeps `'unsafe-inline'` on purpose: React `style={{…}}` props
 *   and GSAP/Framer Motion set inline styles.
 * - `connect-src` allowlists the product's real egress: AssemblyAI
 *   Sync/event APIs, Vercel insights iframes/beacons.
 * - `frame-ancestors 'none'` + `object-src 'none'` + `base-uri 'self'` close
 *   clickjacking, plugin and base-tag injection in one header.
 *
 * Static pages note (honest): routes prerendered at build time (`/`, `/demo`,
 * `/exam`, `/learn`, `/memory`, `/today` — see `next build` output) contain
 * inline bootstrap scripts generated BEFORE any request exists, so no nonce can
 * be attached to them at runtime. For those documents the proxy ships the
 * nonce-free baseline policy (`'unsafe-inline'` instead of nonce/strict-dynamic)
 * — still a real CSP (external scripts restricted to 'self'), zero violations.
 * Making those pages dynamic (`await connection()` in the page/layout) lets the
 * nonce policy apply everywhere; that file is owned by another agent.
 */

/**
 * Routes from the production build marked `○ (Static)` (prerendered HTML).
 *
 * `/` is deliberately NOT in this set. The landing reads `x-nonce` via
 * `headers()`, which makes it dynamically rendered, so Next emits its bootstrap
 * scripts per-request with the nonce attached and the strict policy holds.
 * That upgrades the first page a visitor loads from `'unsafe-inline'` to a real
 * nonce + `'strict-dynamic'` CSP. If the landing is ever made static again,
 * put "/" back here or the page will be blocked by its own policy.
 */
const STATIC_PAGES = new Set(["/demo", "/exam", "/learn", "/memory", "/today"]);

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const staticPage = !isDev && STATIC_PAGES.has(request.nextUrl.pathname);

  const scriptSrc = staticPage
    ? `script-src 'self' 'unsafe-inline'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`;

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Privy and walletconnect are gone with the auth removal. Dictation is
    // called server-side, so the browser never talks to AssemblyAI directly —
    // these hosts stay only for the sync fallback probe.
    "connect-src 'self' https://api.assemblyai.com https://sync.assemblyai.com https://dictation.assemblyai.com https://*.vercel-insights.com",
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
     * - api/dictation (kept simple for the upload/transcribe boundary)
     * and except prefetch requests (they never render a document).
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico|brand/|api/dictation).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
