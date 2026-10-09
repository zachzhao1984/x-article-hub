/**
 * SPEC §22 — Public API.
 *
 * Phase 1 ships only the read endpoints that already work with the Phase 1
 * schema: health, categories and published articles. The search / trending /
 * trending endpoints (SPEC §22) need the FTS table and the ranking scores, which
 * are Phase 4 and Phase 6 respectively.
 */

import { Hono } from 'hono';
import { listArticles, getArticleBySlug } from '../db/articles';
import { listCategories } from '../db/categories';
import { siteConfig } from '../config/site';
import { AppError } from '../lib/errors';
import { clampInt } from '../lib/http';

type PublicEnv = { Bindings: Env };

/**
 * SPEC §22 — public API responses.
 *
 * `listArticles` selects `a.*` because the admin UI needs every column, so the
 * public shape is projected explicitly here. Without this the list endpoint
 * ships `fts_content` (the whole body, segmented for FTS per SPEC §12) on every
 * request, and exposes internal workflow state.
 */
function toPublicArticle(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    summary: row.editor_summary ?? row.ai_summary ?? null,
    author: {
      name: row.author_name,
      username: row.author_username,
      avatar: row.author_avatar,
    },
    category: row.category_slug ? { slug: row.category_slug, name: row.category_name } : null,
    publishedAt: row.published_at,
    publishedAtIso: row.published_at ? new Date(row.published_at as number).toISOString() : null,
    wordCount: row.word_count,
    displayMode: row.display_mode,
    featured: row.featured === 1,
    scores: {
      final: row.final_score,
      popularity: row.popularity_score,
      velocity: row.velocity_score,
      quality: row.quality_score,
    },
    canonicalUrl: row.canonical_url,
  };
}

export const publicApi = new Hono<PublicEnv>();

publicApi.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'x-article-hub',
    phase: '1',
    environment: c.env.ENVIRONMENT ?? 'production',
    site: siteConfig(c.env).origin,
  }),
);

publicApi.get('/categories', async (c) => c.json({ categories: await listCategories(c.env.DB) }));

publicApi.get('/articles', async (c) => {
  const limit = clampInt(c.req.query('limit'), 20, 1, 100);
  const offset = clampInt(c.req.query('offset'), 0, 0, 100_000);

  // Public reads never expose unpublished work (SPEC §6).
  const articles = await listArticles(c.env.DB, {
    status: 'published',
    categorySlug: c.req.query('category'),
    authorUsername: c.req.query('author'),
    limit,
    offset,
  });

  c.header('Cache-Control', 'public, max-age=60, s-maxage=60'); // SPEC §23
  return c.json({ articles: articles.map((a) => toPublicArticle(a as unknown as Record<string, unknown>)), limit, offset });
});

publicApi.get('/articles/:slug', async (c) => {
  const article = await getArticleBySlug(c.env.DB, c.req.param('slug'));
  if (!article || article.status !== 'published') {
    throw new AppError('NOT_FOUND', 'Article not found', 404);
  }

  c.header('Cache-Control', 'public, max-age=300, s-maxage=3600'); // SPEC §23
  return c.json({ article: toPublicArticle(article as unknown as Record<string, unknown>) });
});
