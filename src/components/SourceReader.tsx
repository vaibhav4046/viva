"use client";
import { useEffect, useState } from "react";
import { SOURCE_CHUNKS, DEMO_SOURCE } from "@/lib/course";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import type { SourceChunk } from "@/lib/types";

type SourceMeta = { title: string; line: string };

const STATIC_META: SourceMeta = {
  title: DEMO_SOURCE.title,
  line: `Transformers — Week 4 · COMP532 · ${SOURCE_CHUNKS.length} citable chunks`,
};

/**
 * Course source pane. The default lab renders the registry's own chunks
 * (identical to GET /api/sources); every other lab is fetched from
 * /api/sources?courseId=… so the pane always shows the selected course.
 */
export function SourceReader({ highlightIds = [], courseId }: { highlightIds?: string[]; courseId?: string }) {
  const isDefault = !courseId || courseId === DEMO_SOURCE.courseId;
  const [chunks, setChunks] = useState<SourceChunk[]>(SOURCE_CHUNKS);
  const [meta, setMeta] = useState<SourceMeta>(STATIC_META);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [reloadKey, setReloadKey] = useState(0);

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
          line: `${d.course.code} · ${d.course.title} · ${list.length} citable chunks`,
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
    <section aria-label="Course source" className="surface-card flex max-h-[calc(100vh-8rem)] flex-col p-5 xl:sticky xl:top-20 xl:self-start">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{"{ source }"}</p>
          <h3 className="heading mt-1 text-lg leading-snug">{meta.title}</h3>
          <p className="mono mt-1 text-xs" style={{ color: "var(--color-ash)" }}>
            {meta.line}
          </p>
        </div>
        <span className="mono shrink-0 pt-1 text-[10px] tracking-widest" style={{ color: "var(--color-ash)" }} aria-hidden>
          SCROLL ↓
        </span>
      </div>
      {state === "loading" ? (
        <div className="mt-3">
          <LoadingBlock label="Loading this lab's source text…" lines={4} />
        </div>
      ) : state === "error" ? (
        <div
          className="mt-3 rounded-lg border border-dashed px-4 py-5 text-sm leading-relaxed"
          style={{ borderColor: "var(--color-hairline)", color: "var(--color-mist)" }}
        >
          Couldn&apos;t load this lab&apos;s source text — nothing is faked in its place.{" "}
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
          aria-label="Course passages, grouped by section"
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
                          {hot ? <span className="font-semibold">CITED · </span> : null}
                          {c.id}
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
