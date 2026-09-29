import type { Metadata } from "next";
import "./redteam.css";

const DESCRIPTION = "A live voice red-team for documents you have to defend. Every spoken claim is checked against the source.";

export const metadata: Metadata = {
  title: "VIVA RedTeam · Rehearse the questions your document cannot answer",
  description: DESCRIPTION,
  openGraph: { title: "VIVA RedTeam", description: DESCRIPTION, siteName: "VIVA", type: "website" },
  twitter: { card: "summary_large_image", title: "VIVA RedTeam", description: DESCRIPTION },
};

/**
 * Rendered per request: src/proxy.ts serves a nonce CSP, and only a dynamic
 * document has its bootstrap scripts stamped with that nonce.
 */
export const dynamic = "force-dynamic";

export default function RedTeamLayout({ children }: { children: React.ReactNode }) {
  return children;
}
