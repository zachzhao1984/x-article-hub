-- Migration 0002: seed taxonomy from SPEC §13.5.
-- Five top-level categories. Topics are stored as tags (phase 2 AI assigns them),
-- so only the categories table is seeded here.

INSERT INTO categories (id, slug, name, description, sort_order, created_at) VALUES
  ('cat_ai',         'ai',         'AI',         'Models, agents, coding, robotics and the AI industry.',            10, 1759000000000),
  ('cat_technology', 'technology', 'Technology', 'Developer tools, hardware, semiconductors, cloud and open source.',  20, 1759000000000),
  ('cat_business',   'business',   'Business',   'Startups, SaaS, venture, strategy and markets.',                   30, 1759000000000),
  ('cat_science',    'science',    'Science',    'Biology, physics, space and mathematics.',                         40, 1759000000000),
  ('cat_ideas',      'ideas',      'Ideas',      'Philosophy, the future, society and culture.',                     50, 1759000000000);
