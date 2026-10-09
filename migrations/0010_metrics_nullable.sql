-- SPEC §14.1 — `article_metrics` counters become nullable.
--
-- 0001 declared all six counters `NOT NULL DEFAULT 0`, which was reasonable for a table
-- nothing had written to yet: a metric was imagined as always present, and 0 was the
-- harmless default.
--
-- It is not harmless. There are two different facts — "this article had no engagement" and
-- "the counter was not on the page" — and a NOT NULL column cannot hold the second one. The
-- crawl has to record the difference, because that is the only way a selector that has
-- stopped matching is distinguishable from a quiet article: both would otherwise store 0,
-- both would rank last, and Trending would quietly decay into a second copy of Latest with
-- nothing anywhere reporting a problem.
--
-- ## Why the rebuild
--
-- SQLite cannot drop a NOT NULL constraint with ALTER, and `PRAGMA writable_schema` is not
-- available through D1. The table is empty on production (verified before writing this:
-- `SELECT COUNT(*) FROM article_metrics` is 0 — nothing has ever written a real row, because
-- the collection side did not exist until the same change that added this migration), so the
-- rebuild loses nothing. The seed writer inserts explicit values for all six and is
-- unaffected either way.
--
-- The DEFAULT goes with the NOT NULL. A default of 0 would silently reintroduce the
-- conflation for any future INSERT that omits a column, which is the exact failure this
-- migration exists to prevent.

CREATE TABLE article_metrics_new (
  id          TEXT PRIMARY KEY,
  article_id  TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  -- Nullable, and with no default: absence is a value this table has to be able to hold.
  -- See the note on `EngagementMetrics` in src/jobs/x-selectors.ts.
  likes       INTEGER,
  reposts     INTEGER,
  replies     INTEGER,
  quotes      INTEGER,
  bookmarks   INTEGER,
  views       INTEGER,
  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

INSERT INTO article_metrics_new (id, article_id, captured_at, likes, reposts, replies, quotes, bookmarks, views)
SELECT id, article_id, captured_at, likes, reposts, replies, quotes, bookmarks, views FROM article_metrics;

DROP TABLE article_metrics;
ALTER TABLE article_metrics_new RENAME TO article_metrics;

-- Recreated after the rename, matching 0001's index so the time-series read (newest row per
-- article) keeps its covering index.
CREATE INDEX idx_article_metrics_article ON article_metrics (article_id, captured_at DESC);
