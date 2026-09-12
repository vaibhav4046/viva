"use client";
import { useEffect, useState } from "react";
import { SOURCE_CHUNKS, DEMO_SOURCE } from "@/lib/course";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
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

  useEffect(() => {
    onChunks?.(chunks.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks]);

  useEffect(() => {
    if (isDefault) {
      setChunks(SOURCE_CHUNKS);
      setMeta(STATIC_META);
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
          course: { code: string; title: string };
          chunks: SourceChunk[];
        };
        if (!alive) return;
        const list = Array.isArray(d.chunks) ? d.chunks : [];
        setChunks(list);
        setMeta({
          title: d.source?.title ?? "Course source",
          line: `${d.course.code} · ${d.course.title} · ${list.length} passages`,
        });
        setState("idle");
      } catch {
        if (alive) setState("error");
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
          <h3 className="heading mt-1 text-lg leading-snug">{meta.title}</h3>
          <p className="mono mt-1 text-xs" style={{ color: "var(--color-ash)" }}>
            {meta.line}
          </p>
        </div>
        <span className="mono shrink-0 pt-1 text-[10px] tracking-widest" style={{ color: "var(--color-ash)" }} aria-hidden>
          Scroll
        </span>
      </div>
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
              <h4
                className="eyebrow sticky top-0 z-10 -mx-1 border-b px-1 pb-1.5 pt-1"
                style={{ background: "var(--color-graphite)", borderColor: "var(--color-hairline)" }}
              >
                {s.name}
              </h4>
              <div className="mt-3 space-y-3">
                {s.chunks.map((c) => {
                  const hot = highlightIds.includes(c.id);
                  const number = chunks.indexOf(c) + 1;
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
                        <p className="mono text-[11px]" style={{ color: "var(--color-ash)" }}>
                          §{c.locator.section ?? "—"} · p.{c.locator.page ?? "—"}
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
