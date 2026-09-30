"use client";
import { useEffect, useState } from "react";
import { LevelMeter } from "@/components/ui/exam";
import { smoothLevel } from "./levels";

const POLL_MS = 80;

/**
 * The two-channel level meter, driven by `read()` (analysers on the real
 * microphone and the real playback). It keeps its own state so a 12 Hz poll
 * never re-renders the exam screen. With no `read` it draws the fixed values it
 * is given, which is how the fixture states are drawn.
 */
export function LiveMeter({
  read,
  fixed = { learner: 0, examiner: 0 },
}: {
  read?: () => { learner: number; examiner: number };
  fixed?: { learner: number; examiner: number };
}) {
  const [levels, setLevels] = useState(fixed);

  useEffect(() => {
    if (!read) {
      setLevels(fixed);
      return;
    }
    const id = setInterval(() => {
      const next = read();
      setLevels((prev) => ({
        learner: smoothLevel(prev.learner, next.learner),
        examiner: smoothLevel(prev.examiner, next.examiner),
      }));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [read, fixed]);

  return <LevelMeter learner={levels.learner} examiner={levels.examiner} />;
}
