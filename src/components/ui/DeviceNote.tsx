"use client";
import { useEffect, useState } from "react";
import { storageWorks } from "@/components/mirror";

/**
 * One sentence about where this student's record actually lives.
 *
 * It used to read "tonight's notes stay on this device only" and it was on
 * /study alone — which named the one part that survived. The notes were already
 * written to this browser; the map, the plan and the subjects were the parts
 * that vanished. Now the whole record is mirrored here, so the sentence is true
 * of all of it, and it belongs on every screen that shows a piece of it.
 *
 * The server supplies the wording (`storageNote` from the learner snapshot) and
 * sends null when there is a database, so this renders nothing when the claim
 * would not be true. The one case the server cannot know is a browser that
 * refuses storage: then nothing is kept anywhere and the student should hear
 * that instead, in the band colour the rest of the app uses for trouble.
 */
const BLOCKED =
  "Heads up — this browser is blocking saved data, so your map and your subjects will not be here after a reload. Everything else still works.";

export function DeviceNote({ note }: { note: string | null }) {
  // Resolved in an effect, not in render: storage is probed by writing to it,
  // and the server has no window, so asking during render would disagree with
  // the first client paint.
  const [blocked, setBlocked] = useState<boolean | null>(null);
  useEffect(() => setBlocked(!storageWorks()), []);

  if (blocked === null) return null;
  if (!blocked && !note) return null;
  return (
    <p
      className="mono text-xs leading-relaxed"
      style={{ color: blocked ? "var(--color-band-mixed)" : "var(--color-ash)" }}
    >
      {blocked ? BLOCKED : note}
    </p>
  );
}
