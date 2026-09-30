/**
 * SPEC §22 — Admin API.
 *
 * Phase 1 exposes the endpoints the import workflow and the admin UI actually
 * need. Publishing / review endpoints (SPEC §16.3) belong to Phase 3+ and are
 * deliberately absent rather than stubbed: an endpoint that returns "not
 * implemented" is worse than one that does not exist.
 */

import { Hono } from 'hono';
import type { AdminIdentity } from '../middleware/admin-auth';
import { clearAdminCookie, requireAdmin, setAdminCookie, timingSafeEqual } from '../middleware/admin-auth';
import { importUrls } from '../services/import';
import { getArticleById, listArticles } from '../db/articles';
import { listCrawlJobsForArticle, getCrawlJob, listFailedJobs, updateJobStatus } from '../db/jobs';
import { listEvents } from '../db/events';
import { listCategories } from '../db/categories';
import { retryCrawl } from '../services/import';
import { removeDemoArticles, seedDemoArticles } from '../services/seed-demo';
import {
  archiveArticle,
  overrideCategory,
  overrideSummary,
  publishArticle,
  rejectArticle,
  restoreDisplay,
  setFeatured,
  takedownArticle,
} from '../services/publish';
import { log } from '../lib/logger';
import { AppError } from '../lib/errors';
import { clampInt } from '../lib/http';
import type { ArticleStatus, DisplayMode } from '../jobs/types';

export type AdminEnv = {
  Bindings: Env;
  Variables: { adminIdentity: AdminIdentity };
};

const ARTICLE_STATUSES: ArticleStatus[] = [
  'pending',
  'fetching',
  'fetched',
  'parsing',
  'review',
  'published',
  'rejected',
  'archived',
  'takedown',
  'failed',
];

export const adminApi = new Hono<AdminEnv>();

adminApi.use('*', requireAdmin());

/** SPEC §22 — POST /api/admin/articles/import */
adminApi.post('/articles/import', async (c) => {
  const identity = c.get('adminIdentity');
  const contentType = c.req.header('content-type') ?? '';

  // SPEC §5.1 — accepts `{ urls: [...] }`, `{ text: "..." }` or a raw
  // text/plain paste (which is also how a .txt upload arrives).
  let rawInput: string;
  if (contentType.includes('application/json')) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('BAD_REQUEST', 'Request body is not valid JSON', 400);
    }
    if (Array.isArray((body as { urls?: unknown }).urls)) {
      rawInput = ((body as { urls: unknown[] }).urls as unknown[]).map(String).join('\n');
    } else if (typeof (body as { text?: unknown }).text === 'string') {
      rawInput = (body as { text: string }).text;
    } else {
      throw new AppError('BAD_REQUEST', 'Expected { urls: string[] } or { text: string }', 400);
    }
  } else {
    rawInput = await c.req.text();
  }

  const result = await importUrls(c.env, rawInput, identity.actor);
  return c.json(result, 201);
});

/** SPEC §22 — GET /api/admin/articles */
adminApi.get('/articles', async (c) => {
  const status = c.req.query('status');
  if (status && !ARTICLE_STATUSES.includes(status as ArticleStatus)) {
    throw new AppError('BAD_REQUEST', `Unknown status: ${status}`, 400);
  }

  const limit = clampInt(c.req.query('limit'), 20, 1, 100);
  const offset = clampInt(c.req.query('offset'), 0, 0, 100_000);

  const articles = await listArticles(c.env.DB, {
    status: status as ArticleStatus | undefined,
    categorySlug: c.req.query('category'),
    authorUsername: c.req.query('author'),
    limit,
    offset,
  });

  return c.json({ articles, limit, offset });
});

/** SPEC §22 — GET /api/admin/articles/:id */
adminApi.get('/articles/:id', async (c) => {
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  const [jobs, events] = await Promise.all([listCrawlJobsForArticle(c.env.DB, id), listEvents(c.env.DB, id)]);
  return c.json({ article, jobs, events });
});

/**
 * SPEC §22 — POST /api/admin/articles/:id/retry
 * Phase 1 meaning: re-publish the crawl job message. The actual crawl is Phase 2.
 */
adminApi.post('/articles/:id/retry', async (c) => {
  const identity = c.get('adminIdentity');
  const id = c.req.param('id');
  const { jobId, attempt } = await retryCrawl(c.env, id, identity.actor);

  log.info('queue_published', { article_id: id, job_id: jobId, attempt, actor: identity.actor });
  return c.json({ articleId: id, jobId, attempt, status: 'queued' });
});

/** SPEC §16.4 — failed jobs list. */
adminApi.get('/jobs', async (c) => {
  const status = c.req.query('status');
  if (status && status !== 'failed') {
    throw new AppError('BAD_REQUEST', `Unsupported job status filter: ${status}`, 400);
  }
  const jobs = await listFailedJobs(c.env.DB, clampInt(c.req.query('limit'), 50, 1, 200));
  return c.json({ jobs });
});

/** SPEC §16.2 — category list, used by the admin review forms in later phases. */
adminApi.get('/categories', async (c) => c.json({ categories: await listCategories(c.env.DB) }));

/**
 * SPEC §16.3 — curation actions.
 *
 * Each maps to one state transition in src/services/publish.ts, which validates
 * the SPEC §6 machine and writes a curation_events row. The editor has the final
 * say (SPEC §4.7); the AI suggestion is never what publishes anything.
 */
adminApi.post('/articles/:id/publish', async (c) => {
  const actor = c.get('adminIdentity').actor;
  await publishArticle(c.env, c.req.param('id'), actor);
  return c.json({ id: c.req.param('id'), status: 'published' });
});

adminApi.post('/articles/:id/reject', async (c) => {
  const actor = c.get('adminIdentity').actor;
  await rejectArticle(c.env, c.req.param('id'), actor);
  return c.json({ id: c.req.param('id'), status: 'rejected' });
});

adminApi.post('/articles/:id/archive', async (c) => {
  const actor = c.get('adminIdentity').actor;
  await archiveArticle(c.env, c.req.param('id'), actor);
  return c.json({ id: c.req.param('id'), status: 'archived' });
});

/** SPEC §37 — takedown removes the body from the public site immediately. */
adminApi.post('/articles/:id/takedown', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? '').trim();
  if (!reason) throw new AppError('BAD_REQUEST', 'A takedown requires a reason', 400);

  await takedownArticle(c.env, c.req.param('id'), actor, reason);
  return c.json({ id: c.req.param('id'), status: 'takedown', displayMode: 'takedown' });
});

adminApi.post('/articles/:id/display-mode', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const body = (await c.req.json().catch(() => ({}))) as { displayMode?: string };
  const mode = body.displayMode as DisplayMode | undefined;

  if (!mode || !['full', 'excerpt', 'link_only'].includes(mode)) {
    throw new AppError('BAD_REQUEST', `displayMode must be one of full, excerpt, link_only`, 400);
  }

  await restoreDisplay(c.env, c.req.param('id'), actor, mode);
  return c.json({ id: c.req.param('id'), displayMode: mode });
});

/** SPEC §15 — Editor's Pick. */
adminApi.post('/articles/:id/featured', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const body = (await c.req.json().catch(() => ({}))) as { featured?: boolean };
  const featured = body.featured ?? true;

  await setFeatured(c.env, c.req.param('id'), actor, featured);
  return c.json({ id: c.req.param('id'), featured });
});

/** SPEC §16.3 — edit category / summary. Editor override beats the AI suggestion. */
adminApi.patch('/articles/:id', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    categoryId?: string | null;
    summary?: string;
    displayMode?: string;
  };

  if (body.categoryId !== undefined) await overrideCategory(c.env, id, actor, body.categoryId);
  if (typeof body.summary === 'string') await overrideSummary(c.env, id, actor, body.summary);
  if (body.displayMode !== undefined) {
    const mode = body.displayMode as DisplayMode;
    if (!['full', 'excerpt', 'link_only'].includes(mode)) {
      throw new AppError('BAD_REQUEST', 'Invalid displayMode', 400);
    }
    await restoreDisplay(c.env, id, actor, mode);
  }

  const article = await getArticleById(c.env.DB, id);
  return c.json({ article });
});

/**
 * Demo content for validating the public site while the crawl pipeline is still
 * Phase 2. Explicitly labelled, and removable in one call.
 */
adminApi.post('/demo/seed', async (c) => {
  const identity = c.get('adminIdentity');
  const result = await seedDemoArticles(c.env, { reset: true });
  log.info('import_created', { actor: identity.actor, demo_seeded: result.created });
  return c.json(result, 201);
});

adminApi.post('/demo/clear', async (c) => {
  const removed = await removeDemoArticles(c.env);
  return c.json({ removed });
});

/** SPEC §22 — GET /api/admin/jobs/:id */
adminApi.get('/jobs/:id', async (c) => {
  const job = await getCrawlJob(c.env.DB, c.req.param('id'));
  if (!job) throw new AppError('NOT_FOUND', `Job not found: ${c.req.param('id')}`, 404);
  return c.json({ job });
});

// --- dev shim (SPEC §24) ---------------------------------------------------
// Only meaningful when ADMIN_TOKEN is set, which in practice means local dev.

adminApi.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const secret = c.env.ADMIN_TOKEN;

  if (!secret) {
    throw new AppError('UNAUTHORIZED', 'ADMIN_TOKEN is not configured; put admin behind Cloudflare Access', 401);
  }
  if (!body.token || !timingSafeEqual(body.token, secret)) {
    log.warn('admin_login', { result: 'denied' });
    throw new AppError('UNAUTHORIZED', 'Invalid admin token', 401);
  }

  log.info('admin_login', { result: 'ok', via: 'admin-token' });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  await setAdminCookie(headers, secret, new URL(c.req.url).protocol === 'https:');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});

adminApi.post('/logout', (c) => {
  const headers = new Headers();
  clearAdminCookie(headers);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});
