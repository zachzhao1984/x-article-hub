/**
 * SPEC §17 — read queries for the public site.
 *
 * Two invariants hold for every function here:
 *
 *  1. Only `status = 'published'` is ever returned (SPEC §6).
 *  2. SPEC §37 display_mode is honoured. Reaching "we crawled it" is not the same
 *     as "we may republish the full text", so `link_only` and `excerpt` rows are
 *     listed but must not render their body, and `takedown` rows are invisible.
 */

import type { ArticleRow } from './rows';
import type { ArticleStatus, DisplayMode } from '../jobs/types';
import { deSegment, hasCjk, segmentCjk } from '../lib/cjk';

export type PublicSort = 'latest' | 'trending' | 'featured';

export interface ArticleListItem {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string | null;
  author_username: string | null;
  author_name: string | null;
  published_at: number | null;
  imported_at: number;
  category_slug: string | null;
  category_name: string | null;
  display_mode: DisplayMode;
  featured: 0 | 1;
  word_count: number;
  final_score: number | null;
  velocity_score: number | null;
  popularity_score: number | null;
  quality_score: number | null;
}

/**
 * Everything a card renders, in one read.
 *
 * The cover and the metrics are correlated scalar subqueries rather than joins, and that is
 * deliberate: joining `media_objects` would multiply the row per image — 24 rows for the
 * article with 24 figures — and joining `article_metrics` would multiply it again per
 * snapshot. Both subqueries are covered by an index (`idx_media_article`,
 * `idx_article_metrics_article`).
 *
 * The metrics subqueries take `MAX(captured_at)` because the table is a time series; an
 * earlier snapshot describes a page that no longer exists.
 *
 * `cover_image_id` prefers the article's own first `body` image by position — the figure the
 * author put at the top, which is the one that reads as a cover — and falls back to a
 * generated `cover` row (0012) when the document has no body image at all. Both branches
 * require `r2_key IS NOT NULL`, so the card never points at x.com and never points at a row
 * whose bytes were never stored. The `CASE` keeps both alternatives in one subquery because
 * they are the same slot; a second column would push the choice onto every caller.
 */
const LIST_COLUMNS = `
  a.id, a.slug, a.title, a.excerpt,
  a.author_username, a.author_name,
  a.published_at, a.imported_at,
  c.slug AS category_slug, c.name AS category_name,
  a.display_mode, a.featured, a.word_count,
  a.final_score, a.velocity_score, a.popularity_score, a.quality_score,
  (SELECT m.id FROM media_objects m
    WHERE m.article_id = a.id AND m.r2_key IS NOT NULL AND m.kind IN ('body', 'cover')
    ORDER BY CASE m.kind WHEN 'body' THEN 0 ELSE 1 END, m.position ASC LIMIT 1) AS cover_image_id,
  (SELECT m2.views     FROM article_metrics m2 WHERE m2.article_id = a.id
    ORDER BY m2.captured_at DESC LIMIT 1) AS metric_views,
  (SELECT m2.likes     FROM article_metrics m2 WHERE m2.article_id = a.id
    ORDER BY m2.captured_at DESC LIMIT 1) AS metric_likes,
  (SELECT m2.reposts   FROM article_metrics m2 WHERE m2.article_id = a.id
    ORDER BY m2.captured_at DESC LIMIT 1) AS metric_reposts,
  (SELECT m2.replies   FROM article_metrics m2 WHERE m2.article_id = a.id
    ORDER BY m2.captured_at DESC LIMIT 1) AS metric_replies,
  (SELECT m2.bookmarks FROM article_metrics m2 WHERE m2.article_id = a.id
    ORDER BY m2.captured_at DESC LIMIT 1) AS metric_bookmarks`;

/** SPEC §15 — the three board orderings. */
const SORT_SQL: Record<PublicSort, string> = {
  // SPEC §15 — Latest is `published_at DESC`, newest first.
  latest: 'COALESCE(a.published_at, a.imported_at) DESC, a.id DESC',
  // SPEC §15 — Trending is the blended score.
  trending: 'COALESCE(a.final_score, 0) DESC, COALESCE(a.published_at, a.imported_at) DESC',
  // SPEC §15 — Editor's Pick is the human override, not a score.
  featured: 'COALESCE(a.published_at, a.imported_at) DESC, a.id DESC',
};

export interface PublicListFilter {
  sort?: PublicSort;
  categorySlug?: string;
  tagSlug?: string;
  authorUsername?: string;
  limit?: number;
  offset?: number;
}

export async function listPublishedArticles(db: D1Database, filter: PublicListFilter = {}): Promise<ArticleListItem[]> {
  const limit = Math.min(filter.limit ?? 20, 100);
  const offset = filter.offset ?? 0;
  const sort = filter.sort ?? 'latest';

  const where: string[] = [`a.status = 'published'`, `a.display_mode != 'takedown'`];
  const binds: unknown[] = [];

  if (sort === 'featured') where.push('a.featured = 1');
  if (filter.categorySlug) {
    where.push('c.slug = ?');
    binds.push(filter.categorySlug);
  }
  if (filter.authorUsername) {
    where.push('a.author_username = ?');
    binds.push(filter.authorUsername);
  }
  if (filter.tagSlug) {
    where.push('EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.slug = ?)');
    binds.push(filter.tagSlug);
  }

  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}
         FROM articles a
         LEFT JOIN categories c ON c.id = COALESCE(a.editor_category_id, a.category_id)
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORT_SQL[sort]}
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<ArticleListItem>();

  return results;
}

export interface PublishedArticleDetail extends ArticleRow {
  category_slug: string | null;
  category_name: string | null;
}

/**
 * SPEC §37 — a takedown is not a 404. It is a page that explains the content was
 * removed, so a shared link does not silently look broken.
 *
 * The status filter therefore cannot live in SQL: a takedown sets
 * `status = 'takedown'`, so a `status = 'published'` predicate would make the
 * notice branch unreachable and collapse every takedown into a blank 404.
 */
export async function getPublishedArticleBySlug(
  db: D1Database,
  slug: string,
): Promise<PublishedArticleDetail | null> {
  const article = await db
    .prepare(
      `SELECT a.*, c.slug AS category_slug, c.name AS category_name
         FROM articles a
         LEFT JOIN categories c ON c.id = COALESCE(a.editor_category_id, a.category_id)
        WHERE a.slug = ?1`,
    )
    .bind(slug)
    .first<PublishedArticleDetail>();

  if (!article) return null;

  const isTakedown = article.status === 'takedown' || article.display_mode === 'takedown';
  if (isTakedown) return article;

  // Everything that is not published and not taken down is simply not public.
  return article.status === 'published' ? article : null;
}

export function getArticleTags(db: D1Database, articleId: string): Promise<Array<{ slug: string; name: string }>> {
  return db
    .prepare(
      `SELECT t.slug, t.name
         FROM article_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.article_id = ?
        ORDER BY t.name`,
    )
    .bind(articleId)
    .all<{ slug: string; name: string }>()
    .then((r) => r.results);
}

/**
 * SPEC §12 — FTS5 search. Snippet() gives a highlighted fragment for the results page.
 *
 * The snippet is de-segmented on the way out. It is generated from the indexed text,
 * which has a space either side of every CJK character so that `unicode61` splits it
 * into one token per ideograph, and those spaces would otherwise be rendered. Only the
 * preview is affected — the stored index is never shown.
 */
export async function searchPublishedArticles(
  db: D1Database,
  rawQuery: string,
  limit = 20,
  offset = 0,
): Promise<{ items: Array<ArticleListItem & { snippet: string }>; total: number }> {
  const match = buildFtsQuery(rawQuery);
  if (!match) return { items: [], total: 0 };

  const capped = Math.min(limit, 50);
  const offsetCapped = Math.max(offset, 0);

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM articles_fts f
         JOIN articles a ON a.id = f.article_id
        WHERE articles_fts MATCH ?1 AND a.status = 'published' AND a.display_mode != 'takedown'`,
    )
    .bind(match)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT ${LIST_COLUMNS},
              -- Column 3, positionally. Addressing it by name —
              -- snippet(articles_fts, 'fts_content', …) — looks more robust and is not:
              -- this SQLite build fails to resolve the name and silently falls back to
              -- column 0, which is the UNINDEXED article_id. Every result then previewed
              -- as "art_7i7n5…" instead of the matching sentence, with no error anywhere.
              -- Verified directly against SQLite; the column order is pinned by
              -- tests/unit/cjk-search.test.ts so a reorder cannot pass quietly.
              snippet(articles_fts, 3, '<mark>', '</mark>', '…', 24) AS snippet
         FROM articles_fts f
         JOIN articles a ON a.id = f.article_id
         LEFT JOIN categories c ON c.id = COALESCE(a.editor_category_id, a.category_id)
        WHERE articles_fts MATCH ?1 AND a.status = 'published' AND a.display_mode != 'takedown'
        ORDER BY rank
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(match, capped, offsetCapped)
    .all<ArticleListItem & { snippet: string }>();

  return { items: results.map((r) => ({ ...r, snippet: deSegment(r.snippet) })), total: countRow?.n ?? 0 };
}

/**
 * Turn what a reader typed into an FTS5 MATCH expression.
 *
 * FTS5 treats several characters as syntax (`-`, `"`, `*`, `:`), so raw input is
 * quoted. A malformed query would otherwise surface as a SQL error instead of "no
 * results".
 *
 * Whitespace-separated words are joined as adjacent quoted phrases, which FTS5 reads
 * as "all of these, in any order" — which is what someone typing `claude code` means.
 *
 * A word containing CJK is different. The index stores one token per ideograph (see
 * `src/lib/cjk.ts`), so `投资` has to become the single phrase `"投 资"` — consecutive
 * tokens, in that order — rather than two separate phrases. `"投" "资"` would also be
 * satisfied by an article that mentions 投 and 资 in unrelated sentences, and a
 * search that invents a hit is worse than one that misses. Verified against SQLite
 * directly: `"世 界 你 好"` matches nothing when the body reads `你好世界`.
 *
 * Because a no-space CJK run is one token to a reader, `你好世界` is treated as one
 * four-token phrase and so matches only that exact run — which is the expected
 * behaviour for a query with no spaces in it.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .split(/\s+/)
    .map((t) => t.replace(/["*:^()\[\]{}~-]/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);

  if (tokens.length === 0) return null;

  return tokens
    .map((t) => {
      if (!hasCjk(t)) return `"${t}"`;
      // `segmentCjk` wraps each ideograph in spaces; as one quoted phrase those
      // spaces are the consecutive-token separators FTS5 expects.
      return `"${segmentCjk(t).replace(/ +/g, ' ')}"`;
    })
    .join(' ');
}

// --- SPEC §17.3 — homepage sections ---------------------------------------

export interface CategoryWithCount extends ArticleRow {
  slug: string;
}

export async function listCategoriesWithCounts(
  db: D1Database,
): Promise<Array<{ id: string; slug: string; name: string; description: string | null; count: number }>> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.slug, c.name, c.description,
              (SELECT COUNT(*) FROM articles a
                 LEFT JOIN categories c2 ON c2.id = COALESCE(a.editor_category_id, a.category_id)
                WHERE c2.id = c.id AND a.status = 'published' AND a.display_mode != 'takedown') AS count
         FROM categories c
        ORDER BY c.sort_order ASC, c.name ASC`,
    )
    .all<{ id: string; slug: string; name: string; description: string | null; count: number }>();

  return results;
}

export async function listTagsWithCounts(
  db: D1Database,
  limit = 40,
): Promise<Array<{ slug: string; name: string; count: number }>> {
  const { results } = await db
    .prepare(
      `SELECT t.slug, t.name, COUNT(*) AS count
         FROM article_tags at
         JOIN tags t ON t.id = at.tag_id
         JOIN articles a ON a.id = at.article_id
        WHERE a.status = 'published' AND a.display_mode != 'takedown'
        GROUP BY t.id
        ORDER BY count DESC, t.name ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ slug: string; name: string; count: number }>();

  return results;
}

export interface AuthorSummary {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  article_count: number;
}

export async function listAuthors(db: D1Database, limit = 50): Promise<AuthorSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT a.author_username AS username,
              a.author_name AS display_name,
              a.author_avatar AS avatar_url,
              COUNT(*) AS article_count
         FROM articles a
        WHERE a.status = 'published' AND a.display_mode != 'takedown'
          AND a.author_username IS NOT NULL
        GROUP BY a.author_username
        ORDER BY article_count DESC, username ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<AuthorSummary>();

  return results;
}

export async function getAuthor(db: D1Database, username: string): Promise<AuthorSummary | null> {
  const { results } = await db
    .prepare(
      `SELECT a.author_username AS username,
              a.author_name AS display_name,
              a.author_avatar AS avatar_url,
              COUNT(*) AS article_count
         FROM articles a
        WHERE a.status = 'published' AND a.display_mode != 'takedown'
          AND a.author_username = ?
        GROUP BY a.author_username`,
    )
    .bind(username)
    .all<AuthorSummary>();

  return results[0] ?? null;
}

// --- SPEC §33 — sitemap ---------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod: number;
  changefreq: string;
  priority: string;
}

export async function listSitemapArticles(db: D1Database): Promise<SitemapEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT slug, COALESCE(published_at, updated_at) AS lastmod
         FROM articles
        WHERE status = 'published' AND display_mode != 'takedown' AND slug IS NOT NULL
        ORDER BY lastmod DESC`,
    )
    .all<{ slug: string; lastmod: number }>();

  return results.map((r) => ({
    loc: `/article/${r.slug}`,
    lastmod: r.lastmod,
    changefreq: 'weekly',
    priority: '0.7',
  }));
}

/** SPEC §15 — the homepage is a discovery surface, not a CMS dump. */
export async function homepageCounts(db: D1Database): Promise<{
  total: number;
  trending: number;
  featured: number;
}> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN a.featured = 1 THEN 1 ELSE 0 END) AS featured,
         SUM(CASE WHEN COALESCE(a.final_score, 0) > 0 THEN 1 ELSE 0 END) AS trending
       FROM articles a
       WHERE a.status = 'published' AND a.display_mode != 'takedown'`,
    )
    .first<{ total: number; featured: number | null; trending: number | null }>();

  return {
    total: row?.total ?? 0,
    featured: row?.featured ?? 0,
    trending: row?.trending ?? 0,
  };
}

export type { ArticleStatus, DisplayMode };
