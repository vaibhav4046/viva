"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { SessionView, VoiceConfig } from "@/lib/redteam/controller";
import { MAX_DOC_CHARS, REVIEW_MODES, type ReviewMode } from "@/lib/redteam/types";
import { createReview, loadReview } from "./api";
import { Room } from "./Room";

type Boot = { session: SessionView; voice: VoiceConfig };

const STORE_KEY = "viva.redteam.review";

const MODES: Record<ReviewMode, { name: string; line: string }> = {
  SKEPTIC: { name: "Skeptic", line: "Unsupported claims, contradictions, overconfidence, missing evidence." },
  ARCHITECT: { name: "Architect", line: "Assumptions, tradeoffs, interfaces, scalability, failure modes." },
  OPERATOR: { name: "Operator", line: "Production behaviour, recovery, observability, security, maintenance." },
};

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(STORE_KEY, id);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: the review still works, it just cannot be resumed.
  }
};

export function RedTeamApp() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [resumable, setResumable] = useState<Boot | null>(null);
  const [source, setSource] = useState<"sample" | "paste">("sample");
  const [mode, setMode] = useState<ReviewMode>("SKEPTIC");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let id: string | null = null;
    try {
      id = localStorage.getItem(STORE_KEY);
    } catch {
      return;
    }
    if (!id) return;
    void loadReview(id).then((r) => {
      if (r && r.session.status === "active") setResumable(r);
      else remember(null);
    });
  }, []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await createReview({ mode, sample: source === "sample", ...(source === "paste" ? { title: title.trim() || "Untitled document", text } : {}) });
      remember(r.session.id);
      setBoot(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (boot) {
    return (
      <Room
        key={boot.session.id}
        session={boot.session}
        voice={boot.voice}
        onLeave={() => {
          remember(null);
          setBoot(null);
          setResumable(null);
        }}
      />
    );
  }

  const tooLong = text.length > MAX_DOC_CHARS;
  return (
    <div className="rt">
      <header className="rt-bar">
        <Link href="/" className="rt-brand">
          VIVA <b>RedTeam</b>
        </Link>
      </header>
      <main id="main" className="rt-setup">
        <div className="rt-setup__lead">
          <p className="rt-label">Voice red-team for documents you have to defend</p>
          <h1>Rehearse the questions your document cannot answer.</h1>
          <p>
            Give VIVA the thing you are about to defend. It reads it, then cross-examines you out loud. Every claim you speak is checked against the actual text, and
            you can cut in to correct yourself.
          </p>
          <ul className="rt-jobs" aria-label="Who uses it">
            <li>
              <b>Engineering teams</b> before an architecture review
            </li>
            <li>
              <b>Researchers</b> before a thesis defence
            </li>
            <li>
              <b>Founders</b> before investor diligence
            </li>
            <li>
              <b>Product teams</b> before a design review
            </li>
            <li>
              <b>Policy teams</b> before stakeholder review
            </li>
          </ul>
        </div>

        <form className="rt-setup__form" onSubmit={start} aria-label="Start a review">
          <h2>Start a review</h2>

          {resumable ? (
            <div className="rt-field">
              <span>Unfinished review</span>
              <button
                type="button"
                className="rt-btn"
                data-testid="resume"
                onClick={() => setBoot(resumable)}
              >
                Resume “{resumable.session.document.title.length > 40 ? `${resumable.session.document.title.slice(0, 40)}…` : resumable.session.document.title}” — {resumable.session.claims.length} {resumable.session.claims.length === 1 ? "claim" : "claims"} so far
              </button>
            </div>
          ) : null}

          <fieldset className="rt-field">
            <legend>Document</legend>
            <div className="rt-choice">
              <label className="rt-radio">
                <input type="radio" name="source" checked={source === "sample"} onChange={() => setSource("sample")} />
                <span>
                  <b>Sample technical design</b>
                  <small>“Reliable AI Evaluation Service”. Written for this demo and labelled as sample material.</small>
                </span>
              </label>
              <label className="rt-radio">
                <input type="radio" name="source" checked={source === "paste"} onChange={() => setSource("paste")} data-testid="source-paste" />
                <span>
                  <b>Paste your own</b>
                  <small>Plain text or Markdown, up to {MAX_DOC_CHARS.toLocaleString("en-US")} characters.</small>
                </span>
              </label>
            </div>
          </fieldset>

          {source === "paste" ? (
            <>
              <label className="rt-field">
                <span>Title</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Architecture proposal, v3" />
              </label>
              <label className="rt-field">
                <span>Document text</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the document here." data-testid="doc-text" aria-invalid={tooLong} />
                {tooLong ? <span className="rt-note">That is over the limit. Paste the part you need to defend.</span> : null}
              </label>
            </>
          ) : null}

          <fieldset className="rt-field">
            <legend>Review mode</legend>
            <div className="rt-choice">
              {REVIEW_MODES.map((m) => (
                <label key={m} className="rt-radio">
                  <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} data-testid={`mode-${m}`} />
                  <span>
                    <b>{MODES[m].name}</b>
                    <small>{MODES[m].line}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <p className="rt-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="rt-btn" type="submit" disabled={busy || (source === "paste" && (!text.trim() || tooLong))} data-testid="begin">
            {busy ? "Reading the document…" : "Begin the review"}
          </button>
          <p className="rt-note">
            Voice uses your microphone and AssemblyAI’s Voice Agent. Audio goes from your browser straight to AssemblyAI; VIVA’s server never receives it. If voice is unavailable you can type, and the same checks run.
          </p>
        </form>
      </main>
    </div>
  );
}
