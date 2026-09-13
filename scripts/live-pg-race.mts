/**
 * LIVE proof for the pg first-touch fix — not part of any gate.
 * Fires two genuinely concurrent first events at one concept, three rounds,
 * against the DATABASE_URL in .env.local, then deletes every probe row.
 * Needs network + a database; that is why it lives here next to
 * live-test.mjs instead of in tests/. Exits non-zero on a lost update.
 * Usage: npx tsx scripts/live-pg-race.mts
 */
import { readFileSync } from "node:fs";
import { PgEventStore } from "../src/lib/store/pg";
import { getPool } from "../src/lib/db/db";

const envLine = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .split("\n")
  .find((x) => x.startsWith("DATABASE_URL="));
process.env.DATABASE_URL = (envLine ?? "").slice("DATABASE_URL=".length).trim();

const store = new PgEventStore();
const tag = Date.now().toString(36);

function eventFor(k: string, user: string) {
  return {
    idempotencyKey: k,
    sessionId: "sess_pgrace",
    courseId: "course_transformers_w4",
    sourceId: null,
    transcript: "race probe",
    cleanedTranscript: "race probe",
    origin: "voice",
    transcriptionConfidence: 0.9,
    transcriptionLatencyMs: 100,
    transcriptionSessionId: null,
    intent: "confusion",
    conceptIds: ["c_position"],
    primaryConceptId: "c_position",
    importance: 0.5,
    confusion: 0.9,
    interpretationConfidence: 0.8,
    evidenceIds: [],
    requestedAction: "explain",
    status: "grounded",
    sourceLocator: { section: "3" },
  };
}

for (let round = 0; round < 3; round++) {
  const user = `demo_pgrace_${tag}_${round}`;
  await Promise.all([
    store.recordLearning(user, eventFor(`k_race_${tag}_${round}_a`, user)),
    store.recordLearning(user, eventFor(`k_race_${tag}_${round}_b`, user)),
  ]);
  const m = await store.getMastery(user);
  const exp = m["c_position"]?.exposureCount;
  console.log(`ROUND ${round}: exposure=${exp} ${exp === 2 ? "SERIALISED" : "LOST-UPDATE"}`);
  if (exp !== 2) {
    console.error("LIVE-RACE-FAIL: a concurrent first event was overwritten");
    process.exitCode = 1;
  }
}

// Cleanup: remove every trace of the probe users.
const pool = await getPool();
await pool.query(`DELETE FROM learning_events WHERE user_id LIKE 'demo_pgrace_${tag}\\_%' ESCAPE '\\'`);
await pool.query(`DELETE FROM mastery_state WHERE user_id LIKE 'demo_pgrace_${tag}\\_%' ESCAPE '\\'`);
await pool.query(`DELETE FROM users WHERE id LIKE 'demo_pgrace_${tag}\\_%' ESCAPE '\\'`);
console.log("CLEANED");
await pool.end();
