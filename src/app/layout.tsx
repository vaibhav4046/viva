import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";

/*
 * Typography. Three families, all self-hosted by next/font at build time: the
 * generated @font-face points at /_next/static/media, so there is no runtime
 * request to Google and `font-src 'self'` in the CSP stays untouched. next/font
 * also emits a size-adjusted local fallback for each family, which keeps the
 * layout still when the real font arrives.
 *
 * Newsreader sets the display type and the exam question, the one thing on the
 * exam screen that is read for longer than a second. IBM Plex Sans carries the
 * interface. IBM Plex Mono carries page numbers, timings and passage ids.
 * Weights are the ones the interface uses and no others.
 */
const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-newsreader",
  weight: ["400", "500"],
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-sans",
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

const DESCRIPTION =
  "Upload your lecture notes. VIVA asks you questions out loud, checks your answers against your own pages, and tells you what to revise tomorrow.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://viva-five-murex.vercel.app"),
  title: "VIVA: an oral exam on your own lecture notes",
  description: DESCRIPTION,
  applicationName: "VIVA",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
  openGraph: {
    title: "VIVA: an oral exam on your own lecture notes",
    description: DESCRIPTION,
    siteName: "VIVA",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "VIVA: an oral exam on your own lecture notes",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#F1EDE4",
  colorScheme: "light",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-[var(--on-primary)]"
        >
          Skip to content
        </a>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
