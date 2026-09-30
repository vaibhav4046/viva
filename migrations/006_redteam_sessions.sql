-- VIVA 006: RedTeam review sessions.
--
-- One row per review: the document as cut into passages, the claim ledger, the
-- timeline. `data` is the whole session document; `user_id` is the ownership
-- boundary and every read and delete is scoped to it. A session that belongs to
-- someone else is indistinguishable from one that does not exist.
--
-- The application also creates this table on first use (CREATE TABLE IF NOT
-- EXISTS), so running this by hand is optional.
--
-- Run with: psql $DATABASE_URL -f migrations/006_redteam_sessions.sql

CREATE TABLE IF NOT EXISTS redteam_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redteam_sessions_user ON redteam_sessions(user_id, updated_at DESC);
