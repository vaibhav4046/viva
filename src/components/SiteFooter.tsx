import Link from "next/link";

/*
 * Footer on every page. The four trust pages are written from the code by
 * scripts/data-inventory.mjs; the source link is the repository the judges
 * are reading. Plain links, no icons.
 */
const LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/accessibility", label: "Accessibility" },
  { href: "/about", label: "About" },
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer border-t hairline" style={{ background: "var(--canvas)" }}>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 text-sm sm:px-6">
        <nav aria-label="Legal and project" className="flex flex-wrap items-center gap-x-1">
          {LINKS.map(({ href, label }) => (
            <Link key={href} href={href} className="link inline-flex min-h-11 items-center px-2">
              {label}
            </Link>
          ))}
          <a
            href="https://github.com/vaibhav4046/viva"
            target="_blank"
            rel="noopener noreferrer"
            className="link inline-flex min-h-11 items-center px-2"
          >
            Source
          </a>
        </nav>
        <p className="mono" style={{ color: "var(--text-muted)" }}>
          Hackathon build. Voice by AssemblyAI.
        </p>
      </div>
    </footer>
  );
}
