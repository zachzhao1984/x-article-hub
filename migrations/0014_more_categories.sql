-- Migration 0014: three more top-level categories, and the `ideas` description narrowed to match.
--
-- The archive grew past the five SPEC §13.5 seeds: roughly a fifth of what lands here is games
-- (patch notes, gacha events, esports rosters, game-IP collabs), a sixth is culture and relationships,
-- and the rest includes health, sleep, food and personal-safety writing that none of the five had a
-- home for. Every one of those articles was sitting in "no category", which is what the header
-- filter and /category/<slug> pages are for.
--
-- sort_order continues the existing 10/20/30/40/50 ladder rather than interleaving, so the five
-- seeded categories keep the positions they already had in the filter, the sitemap and the
-- category-page order. The three new ones follow at 60/70/80.
--
-- `ideas` loses the word "culture" from its description: it used to say "Philosophy, the future,
-- society and culture" because culture had nowhere else to go. It does now.

INSERT INTO categories (id, slug, name, description, sort_order, created_at) VALUES
  ('cat_gaming',    'gaming',    'Gaming',    'Video games, game studios, esports and the games industry.',        60, 1791849600000),
  ('cat_culture',   'culture',   'Culture',   'Books, film, music, media, language, relationships and social life.', 70, 1791849600000),
  ('cat_lifestyle', 'lifestyle', 'Lifestyle', 'Health, sleep, food, money, safety and the texture of daily life.',  80, 1791849600000);

UPDATE categories
   SET description = 'Philosophy, arguments about thinking, work and the future.'
 WHERE id = 'cat_ideas';
