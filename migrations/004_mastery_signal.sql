-- VIVA 004: the tutor's direction, stored on the event that produced it.
--
-- `src/lib/mastery.ts` folds `masterySignal` for every claim and teachback
-- turn, but the column did not exist, so the signal lived only in the request
-- that carried it. That is fine while every event is folded exactly once and
-- fatal as soon as a record is replayed: a claim VIVA could not check comes
-- back as an "unverified claim" and charges the learner 0.02 they never lost.
-- Same events, two different maps. Storing it makes the fold repeatable.
--
-- Run with: psql $DATABASE_URL -f migrations/004_mastery_signal.sql

ALTER TABLE learning_events
  ADD COLUMN IF NOT EXISTS mastery_signal TEXT;
