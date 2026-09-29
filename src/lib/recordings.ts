import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Recorded exam sessions, published as static files under public/recordings.
 *
 * Format (written by the recording pipeline, read here and by /recorded):
 *
 *   public/recordings/index.json
 *     { "recordings": [ { "id": "sample-1", "recordedAt": "2026-09-29T14:00:00Z" } ] }
 *   public/recordings/<id>/session.json
 *     {
 *       "id", "recordedAt" (ISO), "course" (title), "learnerVoice": "synthetic",
 *       "audio": "/recordings/<id>/session.wav" (examiner and learner mixed on one timeline),
 *       "durationMs": number,
 *       "turns":  [ { "tMs": number, "speaker": "examiner" | "learner", "text": string } ],
 *       "events": [ { "tMs": number, "kind": "tool" | "state", "name": string, "detail": string } ]
 *     }
 *
 * `learnerVoice` must be the literal "synthetic": a recording that is not
 * labelled synthetic is refused, so an unlabelled synthetic voice cannot ship.
 * Until such a file exists the pages show an honest "not available yet" state.
 */

const Turn = z.object({ tMs: z.number().min(0), speaker: z.enum(["examiner", "learner"]), text: z.string().min(1) });
const Event = z.object({ tMs: z.number().min(0), kind: z.enum(["tool", "state"]), name: z.string(), detail: z.string().default("") });

export const SessionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  recordedAt: z.string().datetime(),
  course: z.string(),
  learnerVoice: z.literal("synthetic"),
  audio: z.string().startsWith("/recordings/"),
  durationMs: z.number().positive(),
  turns: z.array(Turn),
  events: z.array(Event).default([]),
});
export type RecordedSession = z.infer<typeof SessionSchema>;

const IndexSchema = z.object({ recordings: z.array(z.object({ id: z.string(), recordedAt: z.string() })) });

const ROOT = path.join(process.cwd(), "public", "recordings");

function label(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The newest recording, or null when none is published. */
export async function loadRecordingIndex(): Promise<{ id: string; recordedAtLabel: string } | null> {
  const parsed = IndexSchema.safeParse(await readJson(path.join(ROOT, "index.json")));
  if (!parsed.success || parsed.data.recordings.length === 0) return null;
  const newest = [...parsed.data.recordings].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  return { id: newest.id, recordedAtLabel: label(newest.recordedAt) };
}

/** One session, validated. Null when missing or malformed. */
export async function loadRecording(id: string): Promise<RecordedSession | null> {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
  const parsed = SessionSchema.safeParse(await readJson(path.join(ROOT, id, "session.json")));
  return parsed.success ? parsed.data : null;
}

export { label as recordingDateLabel };
