/** SPEC §11.2 / §13.5 — categories. Seeded by migration 0002. */

import type { CategoryRow } from './rows';

export function listCategories(db: D1Database): Promise<CategoryRow[]> {
  return db
    .prepare(`SELECT * FROM categories ORDER BY sort_order ASC, name ASC`)
    .all<CategoryRow>()
    .then((r) => r.results);
}

export function getCategoryBySlug(db: D1Database, slug: string): Promise<CategoryRow | null> {
  return db
    .prepare(`SELECT * FROM categories WHERE slug = ?1`)
    .bind(slug)
    .first<CategoryRow>();
}
