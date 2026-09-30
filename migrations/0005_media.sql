-- Migration 0005: SPEC §10 media objects.
--
-- SPEC §10 specifies the columns to persist per image:
--   image_id, article_id, position, source_url, r2_key, width, height, alt_text
-- plus a status of ready / failed / external_fallback.
--
-- Why a table and not columns on `articles`: one Article has many images, and
-- SPEC §10 keys R2 storage by position (`articles/{articleId}/media/001.webp`),
-- which only means something if position is a per-article ordinal.
--
-- Columns beyond the spec's list, and why:
--
--   kind            The author avatar is also a hotlink to X's CDN, so it goes
--                   through the same pipeline. It is not part of the body
--                   ordinal sequence, and mixing the two would make `position`
--                   ambiguous. `body` images are 1..N; the avatar is position 0.
--   content_type    Needed to serve the right header from /media, and to enforce
--                   SPEC §25's INVALID_CONTENT_TYPE before writing bytes.
--   byte_size       The size cap (SPEC §25 IMAGE_TOO_LARGE) can only be enforced
--                   if the expected size is known up front, and it is useful for
--                   cost monitoring afterwards.
--   error_code      SPEC §25's media errors have to land somewhere. Without them a
--                   permanently broken image is indistinguishable from a
--                   retryable one, and the job cannot tell when to stop.
--
-- `r2_key` being non-null IS the record that we own the bytes. A row with a null
-- r2_key is still pointing at X, whatever its status says.

CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,

  article_id TEXT NOT NULL,

  -- SPEC §10 — the ordinal within the body, matching the R2 key 001.webp.
  position INTEGER NOT NULL,

  -- 'body' for article images, 'avatar' for the author portrait. The avatar is
  -- a separate kind precisely so it never occupies a body ordinal.
  kind TEXT NOT NULL DEFAULT 'body' CHECK (kind IN ('body', 'avatar')),

  source_url TEXT NOT NULL,

  r2_key TEXT,

  width INTEGER,
  height INTEGER,
  alt_text TEXT,

  -- SPEC §10 — `ready` (bytes are ours), `failed` (attempted and did not work),
  -- `external_fallback` (never attempted, or given up on; still on X's CDN).
  status TEXT NOT NULL DEFAULT 'external_fallback'
    CHECK (status IN ('ready', 'failed', 'external_fallback')),

  content_type TEXT,
  byte_size INTEGER,

  error_code TEXT,
  error_message TEXT,

  attempt_count INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- SPEC §19 — a redelivered media job re-derives the same row instead of
  -- duplicating it. Two spellings of the same CDN URL are the same image, so the
  -- source URL is the natural identity.
  UNIQUE (article_id, source_url),
  UNIQUE (article_id, kind, position),

  FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
);

CREATE INDEX idx_media_article ON media_objects (article_id, position);
CREATE INDEX idx_media_status ON media_objects (status);
-- Serves the "which images still need downloading" query without a full scan.
CREATE INDEX idx_media_pending ON media_objects (article_id) WHERE r2_key IS NULL;
