"use client";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { PageHeader } from "@/components/ui/PageHeader";

export default function LearnPage() {
  return (
    <>
      <Nav />
      <main id="main" className="mx-auto max-w-3xl px-5 py-8">
        <PageHeader
          eyebrow="{ sign in }"
          title="Your library lives behind sign-in."
          description="Upload course sources, keep a per-account Thought Mark history, and resume the same mastery graph on any device."
        />
        <div className="mt-6">
          <div className="surface-card p-5">
            <p className="leading-relaxed text-sm" style={{ color: "var(--color-mist)" }}>
              Sign-in is not configured on this deployment. The seeded demo runs the
              same product with an isolated anonymous identity — no account needed.
            </p>
            <div className="mt-5">
              <Link href="/demo" className="btn-primary">Enter the demo instead</Link>
            </div>
          </div>
        </div>
        <p className="mt-8">
          <Link href="/" className="btn-ghost">Back home</Link>
        </p>
      </main>
    </>
  );
}
