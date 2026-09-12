import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Build output dir override for isolated verification lanes (parallel agents
  // rebuilding .next under a running `next start` corrupts chunk serving).
  // Default stays ".next"; set VIVA_DIST_DIR to verify in an isolated lane.
  distDir: process.env.VIVA_DIST_DIR || ".next",
  // pdf-parse (pdfjs + native canvas shims) must NOT be bundled by Turbopack:
  // bundling breaks its worker/native requires at runtime and turns every
  // valid PDF into a parse failure. Externalize it to run as plain Node.
  serverExternalPackages: ["pdf-parse"],
  // No Content-Security-Policy here: it is per-request (nonce) and lives in
  // src/proxy.ts. These headers are the static baseline and stay intact.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          // HSTS: Vercel serves HTTPS everywhere; pin it for two years.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
