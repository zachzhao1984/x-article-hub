/**
 * SPEC §22 — Public API.
 *
 * Phase 1 ships only the read endpoints that already work with the Phase 1
 * schema: health, categories and published articles. The search / trending /
 * rising endpoints (SPEC §22) need the FTS table and the ranking scores, which
 * are Phase 4 and Phase 6 respectively.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { listArticles, getArticleBySlug } from '../db/articles';
import { listCategories } from '../db/categories';
import { siteConfig } from '../config/site';
import { AppError } from '../lib/errors';
import { clampInt } from '../lib/http';

type PublicEnv = { Bindings: Env };

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
  return c.json({ articles, limit, offset });
});

publicApi.get('/articles/:slug', async (c) => {
  const article = await getArticleBySlug(c.env.DB, c.req.param('slug'));
  if (!article || article.status !== 'published') {
    throw new AppError('NOT_FOUND', 'Article not found', 404);
  }

  c.header('Cache-Control', 'public, max-age=300, s-maxage=3600'); // SPEC §23
  return c.json({ article });
});
