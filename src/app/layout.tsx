import type { Metadata, Viewport } from "next";
import { Geist, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/*
 * Typography. Two families, both self-hosted by next/font at build time — the
 * generated @font-face points at /_next/static/media, so there is no runtime
 * request to Google and `font-src 'self'` in the CSP stays untouched.
 *
 * Geist carries the interface; Plex Mono carries numbers, labels and
 * transcripts. The dot-matrix display treatment on the landing headline is
 * CSS over Geist, not a third font.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://viva-five-murex.vercel.app"),
  title: "VIVA · Study out loud",
  description:
    "The study partner you talk to. Think out loud while you study; VIVA catches what you got wrong, asks the one question that fixes it, and quizzes you tomorrow.",
  applicationName: "VIVA",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
  openGraph: {
    title: "VIVA · Study out loud",
    description: "Talk through what you're learning. VIVA remembers what you got wrong and asks you again tomorrow.",
    siteName: "VIVA",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "VIVA · Study out loud",
    description: "Talk through what you're learning. VIVA remembers what you got wrong and asks you again tomorrow.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0c",
  colorScheme: "dark",
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
        {children}
      </body>
    </html>
  );
}
