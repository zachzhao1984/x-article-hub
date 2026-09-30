-- Migration 0003: full-text search (SPEC §12) and public-readiness columns.
--
-- SPEC §42 orders FTS5 at P4, but the public site's /search route (SPEC §17.1)
-- is part of the reading experience being delivered now, and D1 supports FTS5
-- natively — SPEC §12 explicitly says no Elasticsearch is needed.
--
-- `content_text` is the SPEC §12 "pure text index field": the full body stays in
-- R2, and only the derived plain text is mirrored into D1 for indexing.

CREATE VIRTUAL TABLE articles_fts USING fts5(
  article_id UNINDEXED,
  title,
  excerpt,
  content_text,
  author_name,
  author_username,
  tags_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (article_id, title, excerpt, content_text, author_name, author_username, tags_text)
  VALUES (
    new.id,
    new.title,
    COALESCE(new.excerpt, ''),
    COALESCE(new.content_text, ''),
    COALESCE(new.author_name, ''),
    COALESCE(new.author_username, ''),
    COALESCE(new.tags_text, '')
  );
END;

CREATE TRIGGER articles_fts_delete AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE article_id = old.id;
END;

CREATE TRIGGER articles_fts_update AFTER UPDATE ON articles BEGIN
  DELETE FROM articles_fts WHERE article_id = old.id;
  INSERT INTO articles_fts (article_id, title, excerpt, content_text, author_name, author_username, tags_text)
  VALUES (
    new.id,
    new.title,
    COALESCE(new.excerpt, ''),
    COALESCE(new.content_text, ''),
    COALESCE(new.author_name, ''),
    COALESCE(new.author_username, ''),
    COALESCE(new.tags_text, '')
  );
END;

-- SPEC §12: index state lives in D1, the body lives in R2.
ALTER TABLE articles ADD COLUMN content_text TEXT;
ALTER TABLE articles ADD COLUMN tags_text TEXT;

CREATE INDEX idx_articles_published_feed ON articles (published_at DESC) WHERE status = 'published';
CREATE INDEX idx_articles_tags_slug ON article_tags (tag_id, article_id);
