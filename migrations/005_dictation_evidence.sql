-- VIVA 005: the Dictation evidence, stored with the turn that produced it.
--
-- The per-turn footer — "Dictation · AssemblyAI 554 ms · 99% confident", with
-- the verbatim beside the cleaned text — is the only proof a reader ever gets
-- that the speech integration is real, and it lived in React state: visible
-- for one turn, gone on reload. Evidence that does not survive a refresh is
-- not evidence. `transcript` already holds the text the student edited and
-- sent, so what the microphone actually heard needs its own column.
--
-- Run with: psql $DATABASE_URL -f migrations/005_dictation_evidence.sql

ALTER TABLE learning_events
  ADD COLUMN IF NOT EXISTS transcription_mode TEXT,
  ADD COLUMN IF NOT EXISTS transcription_fell_back_from TEXT,
  ADD COLUMN IF NOT EXISTS transcript_verbatim TEXT;
