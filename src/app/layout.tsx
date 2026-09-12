import type { Metadata } from "next";
import { Geist, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/*
 * Typography. Two families, both self-hosted by next/font at build time — the
 * generated @font-face points at /_next/static/media, so there is no runtime
 * request to Google and `font-src 'self'` in the CSP stays untouched.
 *
 * Geist is the face named in the product visual identity (section 18); Plex
 * Mono is what the long-dangling --font-plex-mono token was always reaching
 * for. Before this, --font-display resolved to itself (a cyclic var, i.e.
 * invalid) and --font-body / --font-plex-mono were never defined at all, so
 * every surface silently rendered in the system UI sans.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
  // Landing display type sits at 600; body runs 400/500.
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://viva-vaibhav4046s-projects.vercel.app"),
  title: "VIVA · The AI that learns how you think",
  description:
    "Speak while you learn. VIVA turns questions, confusion and explanations into a living model of what you actually know.",
  icons: { icon: "/brand/viva-mark.svg" },
  openGraph: {
    title: "VIVA · AI tutors remember your notes. VIVA remembers your misunderstandings.",
    description:
      "Hold Space, speak while you learn, and watch every thought become a Thought Mark on your Misconception Graph.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "VIVA · The AI that learns how you think",
    description: "Voice-first learning: speech → learning event → mastery. AssemblyAI Dictation inside.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${plexMono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:text-black"
        >
          Skip to content
        </a>
        {/* Auth lives in src/app/(app)/layout.tsx, not here — the landing has
            no auth surface and should not mount a third-party provider. */}
        {children}
      </body>
    </html>
  );
}
