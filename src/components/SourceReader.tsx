"use client";
import { useEffect, useState } from "react";
import { SOURCE_CHUNKS, DEMO_SOURCE } from "@/lib/course";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Attribution } from "@/components/Attribution";
import { mirroredSubject } from "@/components/mirror";
import type { SourceLicence } from "@/lib/courses/types";
import type { SourceChunk } from "@/lib/types";

type SourceMeta = { title: string; line: string };

const STATIC_META: SourceMeta = {
  title: DEMO_SOURCE.title,
  line: `Transformers — Week 4 · COMP532 · ${SOURCE_CHUNKS.length} passages`,
};

/**
 * Course source pane. The default lab renders the registry's own chunks
 * (identical to GET /api/sources); every other lab is fetched from
 * /api/sources?courseId=… so the pane always shows the selected course.
 *
 * A subject can be several documents now — a textbook chapter, a page from the
 * module site, the student's own notes — so two things travel with the
 * passages. Each document's credit, because a chapter of an openly licensed
 * textbook may only be read here if it says whose work it is; and each
 * document's name, because when there is more than one, "p.4" alone does not
 * say which thing page four is in.
 */
export function SourceReader({
  highlightIds = [],
  courseId,
  onChunks,
}: {
  highlightIds?: string[];
  courseId?: string;
  /** Passage ids in rail order, so a citation chip can carry the rail's number. */
  onChunks?: (ids: string[]) => void;
}) {
  const isDefault = !courseId || courseId === DEMO_SOURCE.courseId;
  /*
   * Seeded with the Transformers passages only when Transformers is what is
   * being read. It used to seed them unconditionally and correct itself in an
   * effect, so opening any other subject flashed a screenful of the wrong
   * source first.
   */
  const [chunks, setChunks] = useState<SourceChunk[]>(isDefault ? SOURCE_CHUNKS : []);
  const [meta, setMeta] = useState<SourceMeta>(isDefault ? STATIC_META : { title: "Your source", line: "Loading…" });
  const [state, setState] = useState<"idle" | "loading" | "error">(isDefault ? "idle" : "loading");
  const [reloadKey, setReloadKey] = useState(0);
  /** One per borrowed document. Empty for the labs VIVA wrote and for your own notes. */
  const [licences, setLicences] = useState<SourceLicence[]>([]);
  /** Document title by source id — only used once a subject has more than one. */
  const [docNames, setDocNames] = useState<Record<string, string>>({});

  useEffect(() => {
    onChunks?.(chunks.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks]);

  useEffect(() => {
    if (isDefault) {
      setChunks(SOURCE_CHUNKS);
      setMeta(STATIC_META);
      setLicences([]);
      setDocNames({});
      setState("idle");
      return;
    }
    let alive = true;
    setState("loading");
    (async () => {
      try {
        const res = await fetch(`/api/sources?courseId=${encodeURIComponent(courseId as string)}`);
        if (!res.ok) throw new Error("sources failed");
        const d = (await res.json()) as {
          source: { title: string } | null;
          sources?: { id: string; title: string; licence: SourceLicence | null }[];
          course: { code: string; title: string };
          chunks: SourceChunk[];
        };
        if (!alive) return;
        const list = Array.isArray(d.chunks) ? d.chunks : [];
        const docs = Array.isArray(d.sources) ? d.sources : [];
        setChunks(list);
        setLicences(docs.map((s) => s.licence).filter((l): l is SourceLicence => Boolean(l)));
        setDocNames(docs.length > 1 ? Object.fromEntries(docs.map((s) => [s.id, s.title])) : {});
        setMeta({
          title: d.source?.title ?? "Course source",
          line: `${d.course.code} · ${d.course.title} · ${list.length} passages`,
        });
        setState("idle");
      } catch {
        if (!alive) return;
        /*
         * The passages are the one thing the tutor is only allowed to quote
         * from, so an empty rail is worse than a stale one: a student reading a
         * citation has nothing to click. A subject this browser built came with
         * its passages attached, so read them from the mirror rather than
         * printing a retry over an empty pane.
         */
        const kept = mirroredSubject(courseId);
        const keptSources = kept?.sources ?? [];
        const keptChunks = keptSources.flatMap((s) => s.chunks);
        if (keptChunks.length) {
          setChunks(keptChunks);
          setLicences(keptSources.map((s) => s.licence).filter((l): l is SourceLicence => Boolean(l)));
          setDocNames(
            keptSources.length > 1 ? Object.fromEntries(keptSources.map((s) => [s.id, s.title])) : {}
          );
          setMeta({
            title: keptSources[0]?.title ?? "Your source",
            line: `${kept?.code ?? ""} · ${kept?.title ?? ""} · ${keptChunks.length} passages`.replace(/^ · /, ""),
          });
          setState("idle");
          return;
        }
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, isDefault, reloadKey]);

  const sections: { name: string; chunks: SourceChunk[] }[] = [];
  for (const c of chunks) {
    const name = c.locator.section ?? "Source";
    const last = sections[sections.length - 1];
    if (last && last.name === name) last.chunks.push(c);
    else sections.push({ name, chunks: [c] });
  }

  return (
    <section aria-label="Your source" className="surface-card flex max-h-[calc(100vh-8rem)] flex-col p-5 xl:sticky xl:top-20 xl:self-start">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Your source</p>
          {/* h2: the first heading under the page title. It was an h3, which
              skips a level and is what a screen reader reports as a missing
              section. Size is the class, not the tag. */}
          <h2 className="heading mt-1 text-lg leading-snug">{meta.title}</h2>
          <p className="mono mt-1 text-xs" style={{ color: "var(--color-ash)" }}>
            {meta.line}
          </p>
        </div>
        <span className="mono shrink-0 pt-1 text-[10px] tracking-widest" style={{ color: "var(--color-ash)" }} aria-hidden>
          Scroll
        </span>
      </div>
      {/* Above the rail, not buried in it: a student who scrolls one passage
          down should not have scrolled past whose work they are reading. */}
      <Attribution licences={licences} className="mt-3 border-t pt-3 hairline" />
      {state === "loading" ? (
        <div className="mt-3">
          <LoadingBlock label="Loading your source…" lines={4} />
        </div>
      ) : state === "error" ? (
        <div
          className="mt-3 rounded-lg border border-dashed px-4 py-5 text-sm leading-relaxed"
          style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
        >
          Couldn&apos;t load your source. Nothing is made up in its place.{" "}
          <button
            type="button"
            className="btn-ghost inline-flex min-h-11 items-center !px-3 !py-1 text-sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          className="scroll-pane mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
          tabIndex={0}
          role="region"
          aria-label="Your source, grouped by section"
        >
          {sections.map((s) => (
            <div key={s.name}>
              <h3
                className="eyebrow sticky top-0 z-10 -mx-1 border-b px-1 pb-1.5 pt-1"
                style={{ background: "var(--color-graphite)", borderColor: "var(--color-hairline)" }}
              >
                {s.name}
              </h3>
              <div className="mt-3 space-y-3">
                {s.chunks.map((c) => {
                  const hot = highlightIds.includes(c.id);
                  const number = chunks.indexOf(c) + 1;
                  const from = docNames[c.sourceId];
                  const section = c.locator.section ?? "—";
                  // "notes-a · §notes-a" is one fact printed twice: a document
                  // with no headings of its own falls back to its own name.
                  const showSection = from !== section;
                  return (
                    <article
                      key={c.id}
                      id={`chunk-${c.id}`}
                      className="rounded-lg border p-3 text-sm leading-relaxed"
                      style={{
                        borderColor: hot ? "var(--color-cognition)" : "var(--color-hairline)",
                        background: hot ? "rgba(184,255,90,0.06)" : "transparent",
                      }}
                    >
                      <p style={{ color: "var(--color-mist)" }}>{c.text}</p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="mono min-w-0 text-[11px]" style={{ color: "var(--color-ash)" }}>
                          {/* Which document, first, once there is more than one:
                              "p.4" says nothing when four things have a page 4. */}
                          {from ? `${from} · ` : ""}
                          {showSection ? `§${section} · ` : ""}p.{c.locator.page ?? "—"}
                        </p>
                        <span id={`cite-${c.id}`} className={hot ? "chip chip-hot" : "chip"}>
                          {hot ? <span className="font-semibold">Quoted · </span> : null}
                          Passage {number}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
