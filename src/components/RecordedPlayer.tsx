"use client";
import { useRef, useState } from "react";
import { PlayIcon } from "@/components/ui/icons";
import type { RecordedSession } from "@/lib/recordings";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Plays one recorded session: the audio, a transcript that follows it, and the
 * tool events (source checks) on the same timeline. Every spoken line is also
 * text. Selecting a line seeks the audio to it.
 */
export function RecordedPlayer({ session }: { session: RecordedSession }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState(0);

  const items = [
    ...session.turns.map((t) => ({ ...t, type: "turn" as const })),
    ...session.events.map((e) => ({ ...e, type: "event" as const })),
  ].sort((a, b) => a.tMs - b.tMs);

  const activeIndex = items.reduce((idx, it, i) => (it.tMs <= now ? i : idx), -1);

  function seek(ms: number) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    void el.play().catch(() => undefined);
  }

  return (
    <div className="space-y-5">
      <audio
        ref={audio}
        controls
        preload="metadata"
        src={session.audio}
        className="w-full"
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime * 1000)}
      />
      <ol className="space-y-2" aria-label="Transcript and source checks">
        {items.map((it, i) => {
          const active = i === activeIndex;
          return (
            <li
              key={`${it.type}-${it.tMs}-${i}`}
              className="surface-card px-4 py-3"
              style={active ? { borderColor: "var(--info)", background: "var(--info-tint)" } : undefined}
              aria-current={active ? "true" : undefined}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="eyebrow">
                  {it.type === "turn" ? (it.speaker === "examiner" ? "Examiner" : "Learner (synthetic voice)") : `Source check: ${it.name}`}
                </span>
                <button type="button" className="btn-ghost !min-h-11 !px-3 !py-1 mono" onClick={() => seek(it.tMs)}>
                  <PlayIcon size={16} />
                  <span>{clock(it.tMs)}</span>
                </button>
              </div>
              <p className="mt-1 max-w-[68ch]">{it.type === "turn" ? it.text : it.detail}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
