"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SessionView, VoiceConfig } from "@/lib/redteam/controller";
import { MAX_DOC_CHARS, REVIEW_MODES, type ReviewMode } from "@/lib/redteam/types";
import { createReview, loadReview } from "./api";
import { IMPORT_MAX_BYTES, IMPORT_MAX_MB, IMPORT_TOO_BIG, importFile, importLink, type ImportedDocument } from "./importApi";
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

/** What the person is told once an import has filled the boxes. */
function importedNote(doc: ImportedDocument, replaced: boolean): string {
  const said = ["Imported."];
  if (replaced) said.push("This replaced what was below.");
  if (doc.truncated) {
    said.push(`The text ran past the ${MAX_DOC_CHARS.toLocaleString("en-US")}-character limit, so VIVA kept the first ${doc.chars.toLocaleString("en-US")} characters.`);
  }
  said.push("Read it and change anything before you begin.");
  return said.join(" ");
}

export function RedTeamApp() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [resumable, setResumable] = useState<Boot | null>(null);
  const [source, setSource] = useState<"sample" | "paste">("sample");
  const [mode, setMode] = useState<ReviewMode>("SKEPTIC");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [importing, setImporting] = useState<"file" | "link" | null>(null);
  const [importNote, setImportNote] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const importCall = useRef<AbortController | null>(null);
  const importFrom = useRef<HTMLElement | null>(null);

  // Leaving the page cancels a read still in flight.
  useEffect(() => () => importCall.current?.abort(), []);

  // A control that is disabled while it works drops the keyboard's place. Put
  // it back on the control that asked, once that control can take it again.
  useEffect(() => {
    if (importing === null && importFrom.current) {
      importFrom.current.focus();
      importFrom.current = null;
    }
  }, [importing]);

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

  const runImport = async (kind: "file" | "link", read: (signal: AbortSignal) => Promise<ImportedDocument>) => {
    const call = new AbortController();
    importCall.current = call;
    setImporting(kind);
    setImportNote("");
    setImportError(null);
    try {
      const doc = await read(call.signal);
      if (call.signal.aborted) return;
      setTitle(doc.title);
      setText(doc.text);
      setImportNote(importedNote(doc, title.trim().length > 0 || text.trim().length > 0));
    } catch (err) {
      if (call.signal.aborted) return;
      setImportError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      if (importCall.current === call) {
        importCall.current = null;
        setImporting(null);
      }
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Emptied so that choosing the same file again still counts as a change.
    e.target.value = "";
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setImportNote("");
      setImportError(IMPORT_TOO_BIG);
      return;
    }
    importFrom.current = e.target;
    void runImport("file", (signal) => importFile(file, signal));
  };

  const startLink = (from: HTMLElement) => {
    const url = link.trim();
    if (!url) {
      setImportNote("");
      setImportError("Paste the link to a page first.");
      return;
    }
    importFrom.current = from;
    void runImport("link", (signal) => importLink(url, signal));
  };

  // Enter in the link box imports the link. It must never begin the review,
  // which is what Enter does everywhere else in this form.
  const onLinkKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (importing === null) startLink(e.currentTarget);
  };

  const chooseSample = () => {
    importCall.current?.abort();
    importCall.current = null;
    importFrom.current = null;
    setImporting(null);
    setImportNote("");
    setImportError(null);
    setSource("sample");
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
  const locked = busy || importing !== null;
  const importStatus = importing === "file" ? "Reading the file…" : importing === "link" ? "Fetching the page…" : importNote;
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
                <input type="radio" name="source" checked={source === "sample"} onChange={chooseSample} />
                <span>
                  <b>Sample technical design</b>
                  <small>“Reliable AI Evaluation Service”. Written for this demo and labelled as sample material.</small>
                </span>
              </label>
              <label className="rt-radio">
                <input type="radio" name="source" checked={source === "paste"} onChange={() => setSource("paste")} data-testid="source-paste" />
                <span>
                  <b>Paste your own</b>
                  <small>Paste text, or import a PDF, Word, text or Markdown file. Up to {MAX_DOC_CHARS.toLocaleString("en-US")} characters.</small>
                </span>
              </label>
            </div>
          </fieldset>

          {source === "paste" ? (
            <>
              <div className="rt-import" role="group" aria-label="Import a document">
                <label className="rt-field">
                  <span>Import a file</span>
                  <input type="file" accept=".pdf,.docx,.txt,.md" onChange={onFile} disabled={locked} aria-describedby="rt-import-file-help" data-testid="import-file" />
                </label>
                <p className="rt-note" id="rt-import-file-help">
                  PDF, Word (.docx), text or Markdown. Up to {IMPORT_MAX_MB} MB.
                </p>
                <div className="rt-field rt-import__link">
                  <label htmlFor="rt-import-url">Import from a link</label>
                  <div className="rt-import__row">
                    <input
                      id="rt-import-url"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={2048}
                      value={link}
                      onChange={(e) => setLink(e.target.value)}
                      onKeyDown={onLinkKey}
                      disabled={locked}
                      placeholder="https://example.com/proposal"
                      aria-describedby="rt-import-link-help"
                      data-testid="import-url"
                    />
                    <button type="button" className="rt-btn rt-import__go" onClick={(e) => startLink(e.currentTarget)} disabled={locked} data-testid="import-url-go">
                      Import
                    </button>
                  </div>
                </div>
                <p className="rt-note" id="rt-import-link-help">
                  A public web page. For a PDF, use the file option.
                </p>
                <p className="rt-note rt-import__status" role="status" data-testid="import-status">
                  {importStatus}
                </p>
                {importError ? (
                  <p className="rt-error" role="alert" data-testid="import-error">
                    {importError}
                  </p>
                ) : null}
              </div>
              <label className="rt-field">
                <span>Title</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Architecture proposal, v3" readOnly={importing !== null} />
              </label>
              <label className="rt-field">
                <span>Document text</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the document here." data-testid="doc-text" aria-invalid={tooLong} readOnly={importing !== null} />
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
          <button className="rt-btn" type="submit" disabled={busy || (source === "paste" && (importing !== null || !text.trim() || tooLong))} data-testid="begin">
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
