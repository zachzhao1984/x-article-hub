-- Migration 0006: allow `media` as a crawl_jobs.job_type.
--
-- `crawl_jobs` CHECKs its job_type against the five values SPEC §19 named when the
-- table was written: crawl, parse, ai, metrics, reindex. SPEC §10's media pipeline
-- needs its own unit of work, and routing it through the existing `parse` type
-- would mean a redelivered parse message could not be told apart from a media one.
--
-- The CHECK has to be rebuilt — SQLite cannot alter one. Foreign keys are deferred
-- across the swap so article_id's cascade survives it.
--
-- The existing partial unique index is named idx_crawl_jobs_open_per_type (it was
-- renamed in Phase 1); the rebuild below keeps that name so no query or migration
-- that references it breaks.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE crawl_jobs_new (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,

  job_type TEXT NOT NULL
    CHECK (job_type IN ('crawl', 'parse', 'media', 'ai', 'metrics', 'reindex')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('pending', 'queued', 'running', 'success', 'failure', 'retrying', 'failed', 'skipped')),

  attempt_count INTEGER NOT NULL DEFAULT 0,
  deliveries INTEGER NOT NULL DEFAULT 0,
  last_delivered_at INTEGER,

  error_code TEXT,
  error_message TEXT,

  started_at INTEGER,
  completed_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

INSERT INTO crawl_jobs_new (
  id, article_id, job_type, status, attempt_count, deliveries, last_delivered_at,
  error_code, error_message, started_at, completed_at, created_at, updated_at
)
  SELECT
  id, article_id, job_type, status, attempt_count, deliveries, last_delivered_at,
  error_code, error_message, started_at, completed_at, created_at, updated_at
  FROM crawl_jobs;

DROP TABLE crawl_jobs;

ALTER TABLE crawl_jobs_new RENAME TO crawl_jobs;

CREATE INDEX idx_crawl_jobs_article ON crawl_jobs (article_id, created_at DESC);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs (status, created_at DESC);
-- SPEC §19 — one open job per (article, type). A redelivered enqueue is a no-op.
CREATE UNIQUE INDEX idx_crawl_jobs_open_per_type ON crawl_jobs (article_id, job_type)
  WHERE status IN ('pending', 'queued', 'running', 'retrying');
