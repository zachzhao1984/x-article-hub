-- Migration 0007: make full-text search work for Chinese (SPEC §12).
--
-- Why this migration exists
-- -------------------------
-- `articles_fts` uses SQLite's `unicode61` tokenizer, which classifies a CJK
-- ideograph as an alphanumeric character. A run of Chinese with no whitespace between
-- it is therefore indexed as ONE token: the archived 美股 article contains the token
-- `一篇讲清楚美股入门的基本逻辑`, and a reader searching for `投资` got nothing back even
-- though the word is in the body. Every Latin query kept working, which is why this
-- went unnoticed for a phase — the acceptance check searches for `cache`, and the
-- unit tests for the query builder are all Latin too.
--
-- The archive is mostly Chinese, so search was broken for the language most of its
-- content is written in.
--
-- What this migration does
-- ------------------------
-- The index now stores text with a separator either side of every CJK character, so
-- `unicode61` splits it into one token per ideograph and `投资` matches. That text is
-- written by `segmentCjk` in src/lib/cjk.ts, at the same three places that write the
-- source columns.
--
-- Two kinds of column are involved, and they are treated differently on purpose:
--
--   * `content_text` and `tags_text` were NEVER SELECTed anywhere — the plain-text
--     index field of SPEC §12, read only by the trigger below. So they are RENAMED to
--     `fts_content` / `fts_tags` and hold the segmented text directly. No second copy
--     of a 9kB body per article, and the name now says what the column is: index text,
--     not something to display.
--
--   * `title`, `excerpt`, `author_name` and `author_username` ARE displayed, so they
--     keep their exact value and gain an `fts_` twin holding the segmented form. The
--     trigger reads `COALESCE(new.fts_title, new.title)`: if a future writer forgets
--     the twin, the index degrades to indexing the raw text — today's behaviour, and
--     Chinese search being no worse than it is now — rather than to an empty index.
--     `tests/unit/cjk-search.test.ts` fails if any `UPDATE articles` sets one of
--     these columns without its twin.
--
-- The tokenizer, the table and the trigger-driven sync are all unchanged. The FTS
-- table's own columns are renamed to match, keeping their order, because
-- `snippet(articles_fts, 3, …)` was addressing a column by position and this change
-- gives it a name instead.

-- Triggers first: SQLite rewrites references inside them when a column is renamed,
-- and the new bodies read different columns entirely. Dropping them makes that moot
-- and makes the recreation below the single source of truth for what gets indexed.
DROP TRIGGER articles_fts_insert;
DROP TRIGGER articles_fts_update;
DROP TRIGGER articles_fts_delete;

-- The index-only columns keep their storage and change their name.
ALTER TABLE articles RENAME COLUMN content_text TO fts_content;
ALTER TABLE articles RENAME COLUMN tags_text TO fts_tags;

-- The displayed columns keep their value and gain a twin.
ALTER TABLE articles ADD COLUMN fts_title TEXT;
ALTER TABLE articles ADD COLUMN fts_excerpt TEXT;
ALTER TABLE articles ADD COLUMN fts_author_name TEXT;
ALTER TABLE articles ADD COLUMN fts_author_username TEXT;

-- The FTS table is dropped and rebuilt rather than altered, which is the only option
-- for a virtual table — its columns belong to its tokenizer, not to a schema you can
-- amend. That empties the index, and this is why every row has to be written back: the
-- twin columns were just created, so `fts_title` is NULL on every row and
-- `scripts/backfill-search-index.mjs`, which selects on exactly that, covers all of
-- them rather than only the ones that happened to be searchable already.
DROP TABLE articles_fts;

-- The indexed columns are renamed to match the source, and the order is preserved so
-- the snippet column is still fourth.
CREATE VIRTUAL TABLE articles_fts USING fts5(
  article_id UNINDEXED,
  fts_title,
  fts_excerpt,
  fts_content,
  fts_author_name,
  fts_author_username,
  fts_tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (
    article_id, fts_title, fts_excerpt, fts_content, fts_author_name, fts_author_username, fts_tags
  )
  VALUES (
    new.id,
    COALESCE(new.fts_title, new.title, ''),
    COALESCE(new.fts_excerpt, new.excerpt, ''),
    COALESCE(new.fts_content, ''),
    COALESCE(new.fts_author_name, new.author_name, ''),
    COALESCE(new.fts_author_username, new.author_username, ''),
    COALESCE(new.fts_tags, '')
  );
END;

CREATE TRIGGER articles_fts_update AFTER UPDATE ON articles BEGIN
  DELETE FROM articles_fts WHERE article_id = old.id;
  INSERT INTO articles_fts (
    article_id, fts_title, fts_excerpt, fts_content, fts_author_name, fts_author_username, fts_tags
  )
  VALUES (
    new.id,
    COALESCE(new.fts_title, new.title, ''),
    COALESCE(new.fts_excerpt, new.excerpt, ''),
    COALESCE(new.fts_content, ''),
    COALESCE(new.fts_author_name, new.author_name, ''),
    COALESCE(new.fts_author_username, new.author_username, ''),
    COALESCE(new.fts_tags, '')
  );
END;

CREATE TRIGGER articles_fts_delete AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE article_id = old.id;
END;

-- Existing rows are NOT backfilled here: segmentation needs `segmentCjk`, which is
-- application code, and a recursive-CTE version in SQL would split a 9kB body into
-- ~9000 rows inside a trigger on D1. `scripts/backfill-search-index.mjs` does it
-- instead — it reads the rows, segments them and writes the twins, and the update
-- trigger above re-indexes as a side effect.