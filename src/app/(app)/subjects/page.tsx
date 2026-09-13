"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Layers, Link2, Sparkles, Type } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { DeviceNote } from "@/components/ui/DeviceNote";
import { Attribution } from "@/components/Attribution";
import { OWN_GROUP, SHIPPED_GROUP, writeStoredCourse } from "@/components/course/CoursePicker";
import { mergeSubjectList, rememberSubject, syncRecord } from "@/components/mirror";
import type { SourceLicence, Subject } from "@/lib/courses/types";

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
 *
 * It also says whose work it is. Most of what VIVA ships now is a chapter of an
 * openly licensed textbook, and showing the credit is the condition on using it
 * — so the credit is part of the card, not a page in a footer somewhere.
 */

type Tab = "paste" | "link" | "files" | "name";

/** What GET /api/subjects returns per card. */
type SubjectCard = {
  id: string;
  title: string;
  subject: string;
  demo: boolean;
  builtBy: string | null;
  conceptCount: number;
  examCount: number;
  /**
   * One entry per borrowed source. Absent on the browser's own mirrored copy
   * of a subject the student built, which never has one.
   */
  attribution?: SourceLicence[];
};

/**
 * The list, and the browser's record handed back in the same call.
 *
 * A subject built ninety seconds ago was absent from eleven consecutive reads,
 * because the write landed in one instance's own /tmp. `syncRecord` replays what
 * the browser kept into whichever instance answers, so the list that comes back
 * contains it; `mergeSubjectList` then adds anything the browser holds that the
 * reply still missed. A plain read is the fallback, and the mirror alone is the
 * fallback after that — a subject the student built is never not on this page.
 */
async function loadSubjects(): Promise<{ cards: SubjectCard[]; storageNote: string | null }> {
  const synced = await syncRecord();
  if (synced?.courses) {
    return {
      cards: mergeSubjectList(synced.courses) as SubjectCard[],
      storageNote: synced.storageNote ?? null,
    };
  }
  const res = await fetch("/api/subjects").catch(() => null);
  const data = res?.ok ? ((await res.json()) as { subjects?: SubjectCard[] }) : null;
  return {
    cards: mergeSubjectList((data?.subjects ?? []) as never) as SubjectCard[],
    storageNote: null,
  };
}

type Built = {
  id: string;
  title: string;
  builtBy: string | null;
  concepts: number;
  questions: number;
  passages: number;
  /** False when nothing durable is behind the deployment. */
  durable?: boolean;
  /** The server's own sentence about where this subject now lives. */
  storageNote?: string | null;
};

/**
 * Mirrors `PDF_MAX_BYTES` in src/lib/intake/pdf.ts and `MAX_DOCS` in
 * src/lib/intake/sources.ts, neither of which can be imported here — the first
 * pulls the parser into the bundle. The page refused at 15 MB while the route
 * refused at 4, so the student picked a lecture deck, waited for the upload and
 * was turned away after committing to the flow.
 */
const MAX_UPLOAD_MB = 4;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_DOCS = 4;

/**
 * How many shipped subjects the shelf shows before it asks.
 *
 * Six is two full rows on a laptop and six phone-lengths of scrolling — enough
 * to see what kind of thing is on offer. Thirteen is a wall you scroll past to
 * reach the box where you add your own, which is the thing most people came
 * for the second time.
 */
const SHELF_PREVIEW = 6;

/**
 * What each refusal means, in one sentence a student can act on.
 *
 * The reason these live here rather than being read off the wire: a code is an
 * internal name, and the screen that shows a refusal is the screen that has to
 * phrase it. The server's own sentence is the fallback for everything not
 * listed, so a new refusal still arrives as words rather than a blank.
 */
const CREATE_ERROR: Record<string, string> = {
  BAD_URL: "That does not look like a web address. Paste the whole link, starting with https://.",
  BLOCKED_HOST: "VIVA only reads pages on the open web, and that address is not one of them.",
  HTTP_ERROR: "That page would not open. It may want a sign-in, or it may be gone — paste the text instead.",
  UNSUPPORTED_TYPE: "That link is not a page VIVA can read. Upload the file itself, or paste the text.",
  TOO_LARGE: "That page is too long to read in one go. Try a single article, or paste the part you are studying.",
  NO_READABLE_TEXT:
    "There was too little to read on that page — it may be mostly video, pictures or a sign-in wall. VIVA will not guess at what it said, so paste the text and it will read that.",
  NO_TEXT_IN_FILE: "There is no readable text in that file. Paste the text instead and VIVA will read that.",
  BAD_FILE: "VIVA reads PDFs, Word documents and plain text. That file is something else — paste the text instead.",
};

function phrase(code: string | null | undefined, message: string | null | undefined): string {
  return (code && CREATE_ERROR[code]) || message || "That did not go through. Try again.";
}

/** One plain sentence per build path. No jargon, no hedging. */
function builtByLine(builtBy: string | null | undefined): string | null {
  if (builtBy === "model") return "A language model read this and wrote the map.";
  if (builtBy === "reading") return "VIVA read these notes itself — no model helped.";
  return null;
}

/**
 * What the two hand-written labs say instead of a credit.
 *
 * They borrow nothing, so there is nothing to attribute — but a card that ends
 * where the others carry a credit reads as a card that lost something. The
 * truthful sentence costs one line and the shelf stops looking broken.
 */
const HOUSE_NOTES_LINE = "Written for VIVA. Every passage is our own.";

export default function SubjectsPage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<SubjectCard[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [tab, setTab] = useState<Tab>("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  /** The shelf opens at six. Thirteen at once is a scroll, not a choice. */
  const [showAll, setShowAll] = useState(false);

  const reload = useCallback(() => {
    void loadSubjects()
      .then(({ cards, storageNote: note }) => {
        setSubjects(cards);
        setStorageNote(note);
        setLoadError(cards.length === 0);
      })
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
    if (tab === "files") {
      if (!files.length) { setError("Choose a file first."); return; }
      if (files.length > MAX_DOCS) { setError(`VIVA reads up to ${MAX_DOCS} files at once. Keep the ones that matter most.`); return; }
      if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) {
        setError(`Those come to more than ${MAX_UPLOAD_MB} MB together, which is more than VIVA can take in one request. Try fewer, or paste the part you are studying.`);
        return;
      }
      const form = new FormData();
      for (const f of files) form.append("file", f);
      if (title.trim()) form.set("title", title.trim());
      body = form;
    } else if (tab === "link") {
      const urls = links.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!urls.length) { setError("Paste the address of the page you want to study."); return; }
      if (urls.length > MAX_DOCS) { setError(`VIVA reads up to ${MAX_DOCS} pages at once. Keep the ones that matter most.`); return; }
      body = JSON.stringify({ kind: "url", urls, ...(title.trim() ? { title: title.trim() } : {}) });
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
        ...(tab === "files" ? {} : { headers: { "Content-Type": "application/json" } }),
        body,
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        setError(phrase(data?.error?.code, data?.error?.message));
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
          let msg: {
            line?: string;
            subject?: Built;
            record?: Subject;
            error?: { code?: string; message?: string };
          };
          try { msg = JSON.parse(part); } catch { continue; }
          if (msg.line) setLines((prev) => [...prev, msg.line as string]);
          if (msg.error) { failed = true; setError(phrase(msg.error.code, msg.error.message)); }
          /*
           * The whole subject travels back with the result, and it is written
           * here before anything navigates. That is what makes "is ready" true:
           * the next load hands it to POST /api/learner/sync, which writes it
           * into whichever instance answers, so /study opens on this material
           * instead of 404ing on an id one lambda alone ever knew about.
           */
          if (msg.record) rememberSubject(msg.record);
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
    { key: "link", label: "Add a link", icon: Link2 },
    { key: "files", label: "Upload files", icon: FileText },
    { key: "name", label: "Just name it", icon: Sparkles },
  ];

  /*
   * Thirteen shipped subjects and however many the student built read as one
   * undifferentiated wall in a single list, and the two kinds are not the same
   * thing: one is a shelf, the other is their own work. Two groups, in the
   * order the page's own sentence promises — ours, then yours.
   */
  const shipped = (subjects ?? []).filter((s) => s.demo);
  const own = (subjects ?? []).filter((s) => !s.demo);
  const visible = showAll ? shipped : shipped.slice(0, SHELF_PREVIEW);

  /*
   * The card is the surface and the button is what fills it — the credit
   * carries links, and a link inside a button is not a thing a browser can
   * render. So the button stops above the hairline and the credit sits under
   * it, still inside the same card.
   *
   * There is no pill on the card any more. Six paper pills on a shelf plus the
   * lime one under the form is seven things shouting the same volume, and only
   * one of them is the thing this page is for. The card was always the control
   * — the pill was a second copy of it — so the card keeps the words and gives
   * them the weight of a caption instead of a button.
   */
  function card(s: SubjectCard) {
    const credit = builtByLine(s.builtBy) ?? (s.demo ? HOUSE_NOTES_LINE : null);
    const licences = s.attribution ?? [];
    return (
      <li
        key={s.id}
        className="surface-card group flex flex-col p-5 transition-colors focus-within:border-[var(--color-cognition)] hover:border-[var(--color-cognition)]"
      >
        <button
          type="button"
          onClick={() => open(s.id)}
          className="flex w-full flex-col items-start gap-2 text-left"
        >
          <span className="eyebrow">{s.subject}</span>
          {/* Two lines reserved whether the name fills them or not, so the
              line under it starts at the same height on every card in the row.
              That row was measured at three different baselines. */}
          <span className="heading line-clamp-2 min-h-[2lh] text-lg">{s.title}</span>
          {/* 12 px, not `.mono`'s 13: at 13 the counts and the affordance came
              to more than the card is wide and "5 / questions" broke across two
              lines, which moved the row it exists to keep level. `ml-auto` so
              that if it ever does wrap it wraps as a whole, still on the right. */}
          <span
            className="mono flex w-full flex-wrap items-center gap-x-3 gap-y-1 !text-[12px]"
            style={{ color: "var(--color-ash)" }}
          >
            <span className="whitespace-nowrap">
              <span className="tnum">{s.conceptCount}</span> concepts · <span className="tnum">{s.examCount}</span>{" "}
              questions
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap transition-colors group-hover:text-[var(--color-paper)]">
              Start talking
              <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
            </span>
          </span>
        </button>
        {/* Every card ends the same way: a rule, then one sentence about whose
            words these are. A card with nothing to credit used to end with the
            rule and nothing after it, which in an equal-height row left a hand-
            written lab with 190 px of empty card where a credit would have been. */}
        {credit || licences.length ? (
          <div className="hairline mt-4 border-t pt-3">
            {credit ? (
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--color-ash)" }}>
                {credit}
              </p>
            ) : null}
            <Attribution licences={licences} className={credit ? "mt-2" : ""} />
          </div>
        ) : null}
      </li>
    );
  }

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

      {shipped.length > 0 ? (
        <section aria-labelledby="shipped-subjects" className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="shipped-subjects" className="heading text-lg">
              {SHIPPED_GROUP}
            </h2>
            <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
              <span className="tnum">{shipped.length}</span> ready to open
            </span>
          </div>
          <p className="mt-1 max-w-prose text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
            The map, the questions and the passages are already built. Pick one and start talking.
          </p>
          <ul id="shipped-list" className="mt-4 grid grid-cols-[minmax(0,1fr)] items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map(card)}
          </ul>
          {shipped.length > SHELF_PREVIEW ? (
            <button
              type="button"
              className="btn-ghost mt-4 !py-2 text-sm"
              aria-expanded={showAll}
              aria-controls="shipped-list"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show fewer" : `Show all ${shipped.length}`}
            </button>
          ) : null}
        </section>
      ) : null}

      {subjects !== null ? (
        <section aria-labelledby="own-subjects" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="own-subjects" className="heading text-lg">
              {OWN_GROUP}
            </h2>
            {own.length > 0 ? (
              <span className="mono text-xs" style={{ color: "var(--color-ash)" }}>
                <span className="tnum">{own.length}</span> you built
              </span>
            ) : null}
          </div>
          {own.length > 0 ? (
            <ul className="mt-4 grid grid-cols-[minmax(0,1fr)] items-start gap-4 sm:grid-cols-2">{own.map(card)}</ul>
          ) : (
            <p className="mt-1 max-w-prose text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
              Nothing of your own yet. Build one below and it lands here.
            </p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="byo" className="surface-card mt-8 p-5">
        <span className="eyebrow inline-flex items-center gap-1.5">
          <Layers size={13} aria-hidden /> Bring your own
        </span>
        <h2 id="byo" className="heading mt-1 text-lg">
          Your own notes
        </h2>
        <p className="mt-1 max-w-prose text-sm leading-relaxed" style={{ color: "var(--color-mist)" }}>
          Paste a lecture, add a link, upload your files, or name the topic. VIVA builds the map, the questions and the
          passages it will quote back at you.
        </p>

        {/* Before the paste, not after it. A student who has already handed over
            862 words and pressed the button has committed; this is the moment
            where the sentence can still change what they do. */}
        <div className="mt-3">
          <DeviceNote note={storageNote} />
        </div>

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

          {tab === "link" ? (
            <label className="grid gap-1.5">
              <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
                ADDRESS · UP TO {MAX_DOCS}, ONE PER LINE
              </span>
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={"https://example.ac.uk/module/week-5-notes\nhttps://…"}
                className="rounded-lg border px-3 py-2 text-sm leading-relaxed"
                style={{ background: "var(--color-obsidian)", borderColor: "var(--color-hairline)", color: "var(--color-paper)", overflowWrap: "anywhere" }}
              />
              <span className="text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
                A page behind a sign-in is a page VIVA cannot open. If that is what you have, paste the words instead.
              </span>
            </label>
          ) : null}

          {tab === "files" ? (
            <label className="grid gap-1.5">
              <span className="mono text-[11px] tracking-widest" style={{ color: "var(--color-ash)" }}>
                PDF, WORD OR TEXT · UP TO {MAX_DOCS}, {MAX_UPLOAD_MB} MB TOGETHER
              </span>
              <input
                type="file"
                multiple
                accept=".pdf,.txt,.md,.markdown,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="min-h-11 rounded-lg border px-3 py-2 text-sm"
                style={{ background: "var(--color-obsidian)", borderColor: "var(--color-hairline)", color: "var(--color-paper)" }}
              />
              {files.length > 1 ? (
                <span className="mono text-[11px]" style={{ color: "var(--color-ash)" }}>
                  <span className="tnum">{files.length}</span> files · one subject built from all of them
                </span>
              ) : null}
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
                ? " That means plainer questions and no worked analogies — everything you see comes straight out of your own words. It also means that when you say something wrong here, VIVA will more often tell you it could not check than catch it. It still quotes your own lines back when it can, and it will not agree with you to be nice."
                : ""}
            </p>
            {/* The route says whether this landed somewhere durable and supplies
                the sentence for when it did not. Printing the counts without it
                was how "is ready · 10 concepts" ended up being untrue. */}
            {built.durable === false && built.storageNote ? (
              <p className="mono mt-2 text-xs leading-relaxed" style={{ color: "var(--color-ash)" }}>
                {built.storageNote}
              </p>
            ) : null}
            <button type="button" onClick={() => open(built.id)} className="btn-primary mt-3">

              Start talking <ArrowRight size={15} aria-hidden />
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
