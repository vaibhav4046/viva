-- VIVA 003: subjects a learner built from their own notes.
--
-- The passages and concepts of a subject live in the normal sources /
-- source_chunks / concepts tables (so retrieval, the map and the mastery fold
-- need no second code path). This table holds the rest of the record —
-- questions, explainers, keyterms, how it was built — as one document, and
-- carries the ownership boundary: every read is scoped to user_id.
--
-- Run with: psql $DATABASE_URL -f migrations/003_subjects.sql

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_subjects_user ON subjects(user_id, created_at DESC);
