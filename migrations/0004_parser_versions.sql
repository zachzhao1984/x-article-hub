-- Migration 0004: let a re-parse produce its own version row.
--
-- SPEC §11.6 declares `UNIQUE (article_id, version)` on article_versions while
-- also carrying a `parser_version` column. Those two cannot both hold: SPEC §27
-- requires that re-running the Parser over unchanged raw output — the whole
-- reason the raw archive is kept — yields a *new* ArticleDocument, and with a
-- per-(article, version) unique key there is nowhere to record it. Re-parsing
-- failed outright with UNIQUE(article_id, version).
--
-- The constraint becomes UNIQUE (article_id, version, parser_version), which is
-- the only shape that satisfies §28 (an unchanged *source* creates no new row)
-- and §27 (an unchanged source with a new *parser* does) at the same time.
--
-- SQLite cannot ALTER a UNIQUE constraint, so the table is rebuilt. Foreign keys
-- are deferred across the swap so the rebuild is atomic.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE article_versions_new (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (article_id, version, parser_version),
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

INSERT INTO article_versions_new (id, article_id, version, parser_version, source_hash, content_hash, r2_key, captured_at, created_at)
  SELECT id, article_id, version, parser_version, source_hash, content_hash, r2_key, captured_at, created_at
  FROM article_versions;

DROP TABLE article_versions;

ALTER TABLE article_versions_new RENAME TO article_versions;

CREATE INDEX idx_article_versions_article ON article_versions (article_id, version DESC);
