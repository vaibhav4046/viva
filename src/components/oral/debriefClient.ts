import type { Debrief, SessionRecord } from "@/lib/oral/debrief";

export type DebriefState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; debrief: Debrief }
  | { status: "error"; message: string };

const KEY = "viva.oral.lastRecord";

/** The last exam's record, so the sheet can be rebuilt after a reload. Ephemeral like the rest of the demo. */
export function saveLastRecord(subjectId: string, record: SessionRecord): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ subjectId, record }));
  } catch {
    // Storage may be blocked. The sheet still shows for this visit.
  }
}

export function loadLastRecord(): { subjectId: string; record: SessionRecord } | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as { subjectId: string; record: SessionRecord }) : null;
  } catch {
    return null;
  }
}

export function recordHasContent(record: SessionRecord): boolean {
  return record.entries.length > 0 || record.userTurns > 0;
}

/** POST the record to the server, which re-checks every quote against the passages. */
export async function requestDebrief(subjectId: string, record: SessionRecord): Promise<Debrief> {
  let res: Response;
  try {
    res = await fetch("/api/oral/debrief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId, record }),
    });
  } catch {
    throw new Error("You look offline, so the debrief could not be built. Reconnect and try again.");
  }
  const body = (await res.json().catch(() => null)) as { debrief?: Debrief; error?: { message?: string } } | null;
  if (!res.ok || !body?.debrief) throw new Error(body?.error?.message ?? "The debrief could not be built. Try again in a moment.");
  return body.debrief;
}
