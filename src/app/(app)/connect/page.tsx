"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plug } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";

/*
 * /connect — hand this browser's study account to the assistant you already
 * work in.
 *
 * VIVA has no sign-in, so there is no password to type into Claude, ChatGPT or
 * Cursor. What there is: a code, generated here, alive for ten minutes, worth
 * exactly one exchange for a key scoped to this account. Voice stays in VIVA.
 * Everything else can happen wherever the student already is.
 */

type Pairing = { code: string; expiresInSeconds: number; survivesDeploys: boolean };

const MINUTE = 60;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" onClick={copy} className="btn-ghost !px-4 !py-1.5 shrink-0 text-xs">
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function Block({ title, body, copyLabel }: { title: string; body: string; copyLabel: string }) {
  return (
    <div className="surface-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2 hairline" style={{ borderBottomWidth: 1 }}>
        <p className="eyebrow">{title}</p>
        <CopyButton value={body} label={copyLabel} />
      </div>
      {/* The command scrolls sideways, so it has to be reachable: without a
          tab stop a keyboard-only student can read the start of the line and
          never the end of it. Named, so the stop says what it is. */}
      <pre
        className="mono overflow-x-auto px-4 py-3 text-[12px] leading-relaxed"
        style={{ color: "var(--color-mist)" }}
        tabIndex={0}
        role="region"
        aria-label={title}
      >
        {body}
      </pre>
    </div>
  );
}

export default function ConnectPage() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!pairing) return;
    setLeft(pairing.expiresInSeconds);
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/pair", { method: "POST" });
      const data = (await res.json()) as Pairing & { error?: { message?: string } };
      if (!res.ok) {
        setError(data?.error?.message ?? "VIVA could not make a code just now. Try again in a moment.");
        return;
      }
      setPairing({ code: data.code, expiresInSeconds: data.expiresInSeconds, survivesDeploys: data.survivesDeploys });
    } catch {
      setError("VIVA could not make a code just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, []);

  const url = origin ? `${origin}/api/mcp` : "…";
  const cli = `claude mcp add --transport http viva ${url}`;
  const config = JSON.stringify({ mcpServers: { viva: { type: "http", url } } }, null, 2);
  const alive = left > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Connect"
        title="Study with VIVA from wherever you already work"
        description="Add VIVA to Claude, Cursor or any assistant that speaks the same tool protocol, then pair it with this browser's account. Your subjects, your map and your notes come with you; the microphone stays here."
      />

      {error ? <ErrorBanner message={error} onRetry={generate} /> : null}

      <section className="space-y-3" aria-labelledby="step-add">
        <h2 id="step-add" className="heading text-lg">
          1 · Add VIVA to your assistant
        </h2>
        <p className="prose-measure text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
          One command in a terminal, or one entry in the config file your assistant already has.
        </p>
        <Block title="Claude Code, one line" body={cli} copyLabel="Copy" />
        <Block title="Claude Desktop, Cursor and friends" body={config} copyLabel="Copy" />
      </section>

      <section className="space-y-3" aria-labelledby="step-pair">
        <h2 id="step-pair" className="heading text-lg">
          2 · Pair it with this account
        </h2>
        <p className="prose-measure text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
          The code below is good for ten minutes and works once. Paste it into your assistant and say: connect my VIVA
          account with this code.
        </p>

        {pairing && alive ? (
          <div className="surface-card space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="eyebrow">Your connection code</p>
              <CopyButton value={pairing.code} label="Copy code" />
            </div>
            <p className="mono break-all text-[13px]" style={{ color: "var(--color-paper)" }}>
              {pairing.code}
            </p>
            <p className="text-xs tnum" style={{ color: "var(--color-ash)" }} aria-live="polite">
              Runs out in {Math.floor(left / MINUTE)}:{String(left % MINUTE).padStart(2, "0")}.
            </p>
            {pairing.survivesDeploys ? null : (
              <p className="prose-measure text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
                Worth knowing: this deployment has no shared signing key set, so a paired assistant is disconnected the
                next time VIVA is updated. Pair again and it works exactly as before.
              </p>
            )}
          </div>
        ) : (
          <button type="button" onClick={generate} disabled={busy} className="btn-lime">
            <Plug size={16} aria-hidden />
            <span>{busy ? "Making one…" : pairing ? "Make a new code" : "Get a connection code"}</span>
          </button>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="step-use">
        <h2 id="step-use" className="heading text-lg">
          3 · Then just ask
        </h2>
        <ul className="prose-measure space-y-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
          <li>“Quiz me on what I am weakest on.”</li>
          <li>“Keep this: attention is not the same as memory.”</li>
          <li>“What should I study today?”</li>
          <li>“What am I mixed up about in histology?”</li>
        </ul>
        <p
          className="prose-measure flex items-start gap-2 text-xs leading-relaxed"
          style={{ color: "var(--color-ash)" }}
        >
          <KeyRound size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Your assistant gets a key that can read and add to this account, and nothing else — no other student is
            reachable with it. Pairing again from this page is the way to hand it to a second assistant; there is no way
            to point a key at somebody else&apos;s subjects.
          </span>
        </p>
      </section>
    </div>
  );
}
