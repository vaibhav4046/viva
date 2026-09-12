-- VIVA 001: core schema. Event history is the durable source of truth;
-- mastery is derived and rebuildable. Every row carries user_id ownership.
-- Run with: psql $DATABASE_URL -f migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  privy_user_id TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT,
  level TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sources_course ON sources(course_id);

CREATE TABLE IF NOT EXISTS source_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  text TEXT NOT NULL,
  locator JSONB NOT NULL DEFAULT '{}',
  search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON source_chunks(source_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_chunks_search ON source_chunks USING GIN(search);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_concepts_course ON concepts(course_id);

CREATE TABLE IF NOT EXISTS concept_edges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  target_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'related',
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  course_id TEXT,
  source_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transcript TEXT NOT NULL,
  cleaned_transcript TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'voice',
  transcription_confidence DOUBLE PRECISION,
  transcription_latency_ms INT,
  transcription_session_id TEXT,
  intent TEXT NOT NULL,
  concept_ids JSONB NOT NULL DEFAULT '[]',
  primary_concept_id TEXT,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  confusion DOUBLE PRECISION NOT NULL DEFAULT 0,
  interpretation_confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  requested_action TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'captured',
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON learning_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_concept ON learning_events(user_id, primary_concept_id);

CREATE TABLE IF NOT EXISTS mastery_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  exposure_count INT NOT NULL DEFAULT 0,
  successful_recall_count INT NOT NULL DEFAULT 0,
  failed_recall_count INT NOT NULL DEFAULT 0,
  confusion_count INT NOT NULL DEFAULT 0,
  misconception_count INT NOT NULL DEFAULT 0,
  teachback_score_avg DOUBLE PRECISION,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_successful_recall_at TIMESTAMPTZ,
  mastery DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3,
  review_priority DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  version INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, concept_id)
);

CREATE TABLE IF NOT EXISTS review_queue (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  priority DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, concept_id)
);

CREATE TABLE IF NOT EXISTS tutor_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tutor_session ON tutor_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS product_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_events_name ON product_events(name, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  suite TEXT NOT NULL,
  pass_count INT NOT NULL,
  fail_count INT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
