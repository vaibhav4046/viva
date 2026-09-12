"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Layers, Sparkles, Type } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { writeStoredCourse } from "@/components/course/CoursePicker";

/*
 * /subjects — pick what you're studying, or bring your own.
 *
 * "Bring your own" posts to /api/subjects/create and reads the reply as it
 * arrives: the route streams one sentence per step, so the page shows the work
 * happening instead of a spinner and a guess at how long it will take.
 *
 * Every card says who did the reading. That is not a footnote: a subject a
 * model wrote the map for and one VIVA pulled out of the words on the page are
 * different products, and the student is the one who should decide whether the
 * weaker one is good enough.
 */

type Tab = "paste" | "pdf" | "name";

/** What GET /api/subjects returns per card. */
type SubjectCard = {
  id: string;
  title: string;
  subject: string;
  demo: boolean;
  builtBy: string | null;
  conceptCount: number;
  examCount: number;
};

async function loadSubjects(): Promise<SubjectCard[]> {
  const res = await fetch("/api/subjects");
  if (!res.ok) throw new Error("subjects fetch failed");
  const data = (await res.json()) as { subjects?: SubjectCard[] };
  return Array.isArray(data.subjects) ? data.subjects : [];
}

type Built = { id: string; title: string; builtBy: string | null; concepts: number; questions: number; passages: number };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** One plain sentence per build path. No jargon, no hedging. */
function builtByLine(builtBy: string | null | undefined): string | null {
  if (builtBy === "model") return "A language model read this and wrote the map.";
  if (builtBy === "reading") return "VIVA read these notes itself — no model helped.";
  return null;
}

export default function SubjectsPage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<SubjectCard[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [tab, setTab] = useState<Tab>("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    void loadSubjects()
      .then(setSubjects)
      .catch(() => setLoadError(true));
  }, []);

  useEffect(reload, [reload]);

  function open(id: string) {
    writeStoredCourse(id);
    router.push(`/study?subject=${encodeURIComponent(id)}`);
  }

  async function create() {
    setError(null);
    setBuilt(null);
    setLines([]);

    let body: BodyInit;
    if (tab === "pdf") {
      if (!file) { setError("Choose a PDF first."); return; }
      if (file.size > MAX_PDF_BYTES) { setError("That PDF is over 15 MB. Try a smaller one, or paste the part you are studying."); return; }
      const form = new FormData();
      form.set("file", file);
      if (title.trim()) form.set("title", title.trim());
      body = form;
    } else if (tab === "paste") {
      if (text.trim().length < 200) { setError("Paste a bit more — a few paragraphs is enough."); return; }
      body = JSON.stringify({ kind: "paste", title: title.trim() || "Your notes", text });
    } else {
      if (title.trim().length < 3) { setError("Give the topic a name first."); return; }
      body = JSON.stringify({ kind: "named", title: title.trim() });
    }

    setBusy(true);
    try {
      const res = await fetch("/api/subjects/create", {
        method: "POST",
        ...(tab === "pdf" ? {} : { headers: { "Content-Type": "application/json" } }),
        body,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? "That did not go through. Try again.");
        return;
      }
      // NDJSON: one JSON object per line, rendered the moment it lands.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let subject: Built | null = null;
      let failed = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          let msg: { line?: string; subject?: Built; error?: { message: string } };
          try { msg = JSON.parse(part); } catch { continue; }
          if (msg.line) setLines((prev) => [...prev, msg.line as string]);
          if (msg.error) { failed = true; setError(msg.error.message); }
          if (msg.subject) { subject = msg.subject; setBuilt(msg.subject); }
        }
      }
      /*
       * There is exactly one thing a student wants after pressing Build my
       * subject, and it is not a card with another button on it. Leaving them
       * on the form with their own 862 words still in the box reads like the
       * build did not work. The result card still renders for the beat before
       * the route changes, and a build that failed stays put so it can say so.
       */
      if (subject && !failed) open(subject.id);
    } catch {
      setError("The connection dropped while VIVA was reading. Nothing was saved — try again.");
    } finally {
      setBusy(false);
      reload();
    }
  }

  const tabs: { key: Tab; label: string; icon: typeof Type }[] = [
    { key: "paste", label: "Paste notes", icon: Type },
    { key: "pdf", label: "Upload a PDF", icon: FileText },
    { key: "name", label: "Just name it", icon: Sparkles },
  ];

  return (
    <>
      <PageHeader
        title="Subjects"
        description="Start with one of ours, or bring your own notes and let VIVA build the map."
      />

      {loadError ? (
        <div className="mt-5">
          <ErrorBanner message="Couldn't load your subjects. The server may still be waking up." onRetry={() => location.reload()} retryLabel="Try again" />
        </div>
      ) : null}

      {subjects === null && !loadError ? (
        <div className="mt-5">
          <LoadingBlock label="Loading subjects…" lines={3} />
        </div>
      ) : null}

      <ul className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
        {(subjects ?? []).map((s) => {
          const line = builtByLine(s.builtBy);
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => open(s.id)}
                className="surface-card flex h-full w-full flex-col items-start gap-2 p-5 text-left transition-colors hover:border-[var(--color-cognition)]"
              >
                <span className="eyebrow">{s.subject}</span>
                <span className="heading text-lg">{s.title}</span>
                <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                  <span className="tnum">{s.conceptCount}</span> concepts · <span className="tnum">{s.examCount}</span> questions
                </span>
                {line ? (
                  <span className="text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
                    {line}
                  </span>
                ) : null}
                {/*
                  * The same words in the same product get the same shape: the
                  * paper pill the result card below already uses. A lime text
                  * link here was the third of four costumes for "Start talking"
                  * and two of them were visible on this screen at once.
                  * `btn-primary` on a span, not a button — the whole card is
                  * already the control.
                  */}
                <span className="btn-primary mt-auto">
                  Start talking <ArrowRight size={15} aria-hidden />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="byo" className="surface-card mt-6 p-5">
        <span className="eyebrow inline-flex items-center gap-1.5">
          <Layers size={13} aria-hidden /> Bring your own
        </span>
        <h2 id="byo" className="heading mt-1 text-lg">
          Your own notes
        </h2>
        <p className="mt-1 max-w-prose text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
          Paste a lecture, drop a PDF, or name the topic. VIVA builds the map, the questions and the passages it will
          quote back at you.
        </p>

        <div role="tablist" aria-label="How to add a subject" className="mt-4 flex flex-wrap gap-2">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => { setTab(key); setError(null); }}
              className="chip chip-link min-h-11 px-4"
              /*
               * Same selected state as /exam's Answer questions / Teach VIVA
               * toggle: graphite fill, hairline border, weight 600. A lime
               * border here put two lime objects in one card, 400 px apart,
               * and one of them is the primary action.
               */
              style={
                tab === key
                  ? {
                      background: "var(--color-panel)",
                      borderColor: "var(--color-hairline)",
                      color: "var(--color-paper)",
                      fontWeight: 600,
                    }
                  : { borderColor: "transparent" }
              }
            >
              <Icon size={13} aria-hidden /> {label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-3">
          <label className="grid gap-1.5">
            <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
              {tab === "name" ? "TOPIC" : "NAME IT (OPTIONAL)"}
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tab === "name" ? "Organic chemistry, week 3: SN1 vs SN2" : "Krebs cycle, week 5"}
              className="min-h-11 rounded-lg border px-3 py-2 text-sm"
              style={{ background: "var(--color-obsidian)", borderColor: "var(--color-hairline)", color: "var(--color-paper)" }}
            />
          </label>

          {tab === "paste" ? (
            <label className="grid gap-1.5">
              <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
                YOUR NOTES
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder="Paste a lecture, a chapter, or your own writing…"
                className="rounded-lg border px-3 py-2 text-sm leading-relaxed"
                style={{ background: "var(--color-obsidian)", borderColor: "var(--color-hairline)", color: "var(--color-paper)" }}
              />
              <span className="mono text-[11px]" style={{ color: "var(--color-ash)" }}>
                <span className="tnum">{text.trim() ? text.trim().split(/\s+/).length : 0}</span> words
              </span>
            </label>
          ) : null}

          {tab === "pdf" ? (
            <label className="grid gap-1.5">
              <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
                PDF · UP TO 15 MB
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="min-h-11 rounded-lg border px-3 py-2 text-sm"
                style={{ background: "var(--color-obsidian)", borderColor: "var(--color-hairline)", color: "var(--color-paper)" }}
              />
              <span className="text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
                A scanned PDF has no text in it. If that is what you have, paste the words instead — VIVA will not guess
                at pages it cannot read.
              </span>
            </label>
          ) : null}

          {tab === "name" ? (
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
              With no notes to read, VIVA writes the passages for you and labels them as its own. Your own material
              always makes a better subject, because every question can point back at a line you wrote.
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void create()} disabled={busy} className="btn-lime">
            {busy ? "Building…" : "Build my subject"}
          </button>
          {busy ? (
            <span className="mono text-xs" style={{ color: "var(--color-ash)" }} aria-hidden>
              This takes up to a minute.
            </span>
          ) : null}
        </div>

        {lines.length > 0 ? (
          <ol className="mt-4 grid gap-1.5" aria-live="polite">
            {lines.map((line, i) => (
              <li key={`${line}-${i}`} className="mono text-xs" style={{ color: i === lines.length - 1 && busy ? "var(--color-paper)" : "var(--color-ash)" }}>
                {line}
              </li>
            ))}
          </ol>
        ) : null}

        {error ? (
          <div className="mt-4">
            <ErrorBanner message={error} onRetry={() => void create()} retryLabel="Try again" />
          </div>
        ) : null}

        {built ? (
          <div className="surface-card mt-4 p-4" aria-live="polite">
            <p className="heading text-base">{built.title} is ready.</p>
            <p className="mono mt-1 text-xs" style={{ color: "var(--color-ash)" }}>
              <span className="tnum">{built.concepts}</span> concepts · <span className="tnum">{built.questions}</span>{" "}
              questions · <span className="tnum">{built.passages}</span> passages
            </p>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
              {builtByLine(built.builtBy) ?? ""}
              {built.builtBy === "reading"
                ? " That means plainer questions and no worked analogies — everything you see comes straight out of your own words."
                : ""}
            </p>
            <button type="button" onClick={() => open(built.id)} className="btn-primary mt-3">
              Start talking <ArrowRight size={15} aria-hidden />
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
