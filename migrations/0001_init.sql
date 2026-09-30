-- Migration 0001: initial schema
-- Source of truth: SPEC §11 (data model) and SPEC §37 (content governance).
--
-- Timestamps are INTEGER unix milliseconds (epoch ms) throughout.

CREATE TABLE authors (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  quality_score REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- SPEC §11.4.
-- Deviation from the spec, documented in README "Schema deviations":
--   * `title` has DEFAULT '' because an article row is created at import time,
--     before any crawl has produced a real title. The Parser (Phase 3) fills it in.
--   * `slug` / `featured` / `display_mode` / `takedown_*` / `article_counts`
--     are required by SPEC §15 (Editor's Pick), §17.1 (/article/:slug) and
--     §37 (governance) and are added up front so later phases need no ALTER.
CREATE TABLE articles (
  id TEXT PRIMARY KEY,

  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,

  x_article_id TEXT UNIQUE,
  x_post_id TEXT,

  slug TEXT UNIQUE,

  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT,

  author_id TEXT,
  author_name TEXT,
  author_username TEXT,
  author_avatar TEXT,

  published_at INTEGER,
  imported_at INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'fetching', 'fetched', 'parsing', 'review',
      'published', 'rejected', 'archived', 'takedown', 'failed'
    )),

  category_id TEXT,

  ai_summary TEXT,
  ai_category TEXT,
  ai_confidence REAL,

  editor_category_id TEXT,
  editor_summary TEXT,

  quality_score REAL,
  popularity_score REAL,
  velocity_score REAL,
  editor_score REAL,
  final_score REAL,

  parser_version INTEGER NOT NULL DEFAULT 1,

  content_r2_key TEXT,
  raw_r2_key TEXT,

  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),

  display_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (display_mode IN ('full', 'excerpt', 'link_only', 'takedown')),

  takedown_requested_at INTEGER,
  takedown_reason TEXT,

  word_count INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_articles_status ON articles (status);
CREATE INDEX idx_articles_published_at ON articles (published_at DESC);
CREATE INDEX idx_articles_final_score ON articles (final_score DESC);
CREATE INDEX idx_articles_velocity_score ON articles (velocity_score DESC);
CREATE INDEX idx_articles_category ON articles (category_id, published_at DESC);
CREATE INDEX idx_articles_author_username ON articles (author_username);
CREATE INDEX idx_articles_updated_at ON articles (updated_at DESC);

CREATE TABLE article_tags (
  article_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, tag_id),
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
);

CREATE INDEX idx_article_tags_tag ON article_tags (tag_id);

CREATE TABLE article_versions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (article_id, version),
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

CREATE INDEX idx_article_versions_article ON article_versions (article_id, version DESC);

CREATE TABLE article_metrics (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

CREATE INDEX idx_article_metrics_article ON article_metrics (article_id, captured_at DESC);

-- SPEC §11.8, plus `deliveries` / `last_delivered_at` for queue observability (SPEC §35).
CREATE TABLE crawl_jobs (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,

  job_type TEXT NOT NULL
    CHECK (job_type IN ('crawl', 'parse', 'ai', 'metrics', 'reindex')),
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

CREATE INDEX idx_crawl_jobs_article ON crawl_jobs (article_id, created_at DESC);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs (status, created_at DESC);
CREATE UNIQUE INDEX idx_crawl_jobs_open_per_type
  ON crawl_jobs (article_id, job_type)
  WHERE status IN ('pending', 'queued', 'running', 'retrying');

CREATE TABLE curation_events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN (
      'import', 'publish', 'reject', 'archive', 'restore', 'takedown',
      'category_override', 'summary_override', 'featured', 'unfeatured', 'retry'
    )),
  actor TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

CREATE INDEX idx_curation_events_article ON curation_events (article_id, created_at DESC);
