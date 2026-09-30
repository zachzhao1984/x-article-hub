/** SPEC §11.4 — article persistence. */

import type { ArticleRow } from './rows';
import type { ArticleStatus, DisplayMode } from '../jobs/types';

export interface NewArticle {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  xArticleId: string;
  slug: string;
  username: string;
}

export async function createArticle(db: D1Database, article: NewArticle): Promise<ArticleRow> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO articles (
         id, source_url, canonical_url, x_article_id, slug,
         title, status, imported_at, display_mode, featured,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 'full', 0, ?8, ?8)`,
    )
    .bind(
      article.id,
      article.sourceUrl,
      article.canonicalUrl,
      article.xArticleId,
      article.slug,
      // No title yet: a crawl has not run (SPEC §6 — `imported` precedes `fetching`).
      article.username ? `@${article.username} on X` : '',
      now,
      now,
    )
    .run();

  return getArticleById(db, article.id) as Promise<ArticleRow>;
}

/** SPEC §5.3 — the dedup lookup. `canonical_url` is UNIQUE. */
export function getArticleByCanonicalUrl(db: D1Database, canonicalUrl: string): Promise<ArticleRow | null> {
  return db
    .prepare(`SELECT * FROM articles WHERE canonical_url = ?1`)
    .bind(canonicalUrl)
    .first<ArticleRow>();
}

export function getArticleById(db: D1Database, id: string): Promise<ArticleRow | null> {
  return db.prepare(`SELECT * FROM articles WHERE id = ?1`).bind(id).first<ArticleRow>();
}

export function getArticleBySlug(db: D1Database, slug: string): Promise<ArticleRow | null> {
  return db.prepare(`SELECT * FROM articles WHERE slug = ?1`).bind(slug).first<ArticleRow>();
}

export async function setArticleStatus(db: D1Database, id: string, status: ArticleStatus): Promise<void> {
  const now = Date.now();
  await db.prepare(`UPDATE articles SET status = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, status, now).run();
}

export async function setDisplayMode(
  db: D1Database,
  id: string,
  mode: DisplayMode,
  reason?: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE articles
          SET display_mode = ?2,
              takedown_requested_at = CASE WHEN ?2 = 'takedown' THEN ?3 ELSE takedown_requested_at END,
              takedown_reason      = CASE WHEN ?2 = 'takedown' THEN ?4 ELSE takedown_reason END,
              updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, mode, now, reason ?? null)
    .run();
}

export interface ListArticlesFilter {
  status?: ArticleStatus;
  categorySlug?: string;
  authorUsername?: string;
  limit?: number;
  offset?: number;
}

/** SPEC §15 / §22 — list used by both the public API and the admin UI. */
export async function listArticles(db: D1Database, filter: ListArticlesFilter = {}): Promise<ArticleRow[]> {
  const limit = Math.min(filter.limit ?? 20, 100);
  const offset = filter.offset ?? 0;

  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.status) {
    where.push('a.status = ?');
    binds.push(filter.status);
  }
  if (filter.categorySlug) {
    where.push('c.slug = ?');
    binds.push(filter.categorySlug);
  }
  if (filter.authorUsername) {
    where.push('a.author_username = ?');
    binds.push(filter.authorUsername);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { results } = await db
    .prepare(
      `SELECT a.*, c.name AS category_name, c.slug AS category_slug
         FROM articles a
         LEFT JOIN categories c ON c.id = COALESCE(a.editor_category_id, a.category_id)
        ${clause}
        ORDER BY COALESCE(a.published_at, a.imported_at) DESC, a.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<ArticleRow>();

  return results;
}
