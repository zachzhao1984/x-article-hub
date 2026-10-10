-- SPEC §43 — saved articles.
--
-- A reader's private bookmark list. The first feature attached to the account system, and
-- the reason the accounts in §43 were built without one: a table like this needs a person to
-- belong to, and adding one later is a CREATE rather than a redesign.
--
-- ## The key is (user, article), not a surrogate id
--
-- Saving is a yes/no fact about a pair, so the pair is the primary key. A generated `sav_…`
-- id would allow the same reader to save the same article twice, and the only defence would
-- be an application-level check that some future code path can forget. `PRIMARY KEY
-- (user_id, article_id)` makes it impossible at the storage layer, which is what
-- `INSERT … ON CONFLICT DO NOTHING` below relies on to make the save idempotent.
--
-- ## `ON DELETE CASCADE` on both sides
--
--   article_id -> articles  deleting an article with the admin's hard delete must not leave
--                           a saved row pointing at nothing. The list would render a gap or
--                           crash on a null join, depending on the query.
--   user_id    -> users     deleting an account must take its saves, same reasoning.
--
-- Neither is hypothetical here: both deletes exist and are reachable from the UI.
--
-- ## No soft delete, and no "deleted_at"
--
-- Unsaving is the literal opposite of saving, and there is nothing to audit — nobody needs
-- to know that a reader removed something from a private list they are the only person who
-- can see. A tombstone column would be a second state for every query to remember to filter.

CREATE TABLE saved_articles (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  -- The ordering key for the list. Kept rather than deriving it from the article, because
  -- "when I saved it" and "when it was published" are different questions and the list is
  -- about the reader's own history.
  saved_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, article_id)
);

-- The list query: one reader's saves, newest first. The primary key already covers
-- (user_id, article_id) lookups, so this index exists for the sort rather than the filter.
CREATE INDEX idx_saved_user_time ON saved_articles (user_id, saved_at DESC);

-- "How many readers saved this" is a question the article page may want later, and the
-- reverse lookup is not served by the primary key's leading column.
CREATE INDEX idx_saved_article ON saved_articles (article_id);
