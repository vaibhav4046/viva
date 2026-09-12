-- VIVA 002: replayable per-event outcomes on learning_events.
-- Also adds source_locator, which recordLearning() already inserts.
-- Run with: psql $DATABASE_URL -f migrations/002_outcome_columns.sql

ALTER TABLE learning_events
  ADD COLUMN IF NOT EXISTS assessment TEXT,
  ADD COLUMN IF NOT EXISTS delta DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS hint TEXT,
  ADD COLUMN IF NOT EXISTS source_locator JSONB;
