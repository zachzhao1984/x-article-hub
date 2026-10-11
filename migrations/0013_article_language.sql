-- Migration 0013: the language of an article, for the card badge.
--
-- ## Why a stored column rather than a computed one
--
-- The card already selects its fields from `articles` (SPEC §15 / LIST_COLUMNS). Detecting
-- the language at read time would mean scanning each article's body text on every list
-- render — for a homepage that shows a dozen cards, twelve full-text scans per request — and
-- would make the value unusable for filtering or ordering in SQL, which is exactly what a
-- language facet would be for.
--
-- It is the same reasoning that put `word_count` and `block_count` in this table: a property
-- the parser derives once, from text it already has in hand, and everything downstream reads.
--
-- ## Why nullable with no default
--
-- NULL means "not detected yet", which is the honest state for an article that has been
-- imported but not parsed. A default of `'latin'` would make every unparsed row claim to be
-- Latin-script, and the backfill could never tell which rows it had actually looked at. The
-- card omits the badge when the value is NULL, so an unparsed article shows nothing rather
-- than a guess.
--
-- ## The values
--
-- `zh` / `ja` / `ko` / `latin`. Latin-script languages are not distinguished — see the note
-- in `src/lib/language.ts` on why guessing between them would be a wrong claim rather than a
-- coarse one. The CHECK keeps a future writer from inventing a value the UI cannot label.

ALTER TABLE articles ADD COLUMN lang TEXT CHECK (lang IN ('zh', 'ja', 'ko', 'latin'));

-- The backfill index: the remaining work is "which rows have not been detected yet", and
-- that is a scan of this column. Partial, so it stays small.
CREATE INDEX idx_articles_lang_pending ON articles (id) WHERE lang IS NULL;
