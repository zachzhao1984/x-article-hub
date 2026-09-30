/**
 * SPEC §16 — Admin UI routes.
 *
 * Server-rendered HTML. The import form posts to itself so the whole flow works
 * with JavaScript disabled, which is also the easiest thing to smoke-test.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import type { AdminIdentity } from '../middleware/admin-auth';
import { requireAdmin, setAdminCookie, clearAdminCookie } from '../middleware/admin-auth';
import { siteConfig } from '../config/site';
import { dashboardStats } from '../db/stats';
import { getArticleById, listArticles } from '../db/articles';
import { listCrawlJobsForArticle, listFailedJobs } from '../db/jobs';
import { listEvents } from '../db/events';
import { importUrls, retryCrawl } from '../services/import';
import { AppError } from '../lib/errors';
import { clampInt } from '../lib/http';
import type { ArticleStatus } from '../jobs/types';
import {
  articleDetailView,
  articleListView,
  dashboardView,
  importView,
  jobListView,
  loginView,
} from './views';

type AdminUiEnv = {
  Bindings: Env;
  Variables: { adminIdentity: AdminIdentity };
};

const STATUSES: ArticleStatus[] = [
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

export const adminUi = new Hono<AdminUiEnv>();

// The login page is the only route that is not behind requireAdmin().
adminUi.get('/login', (c) => c.html(loginView(undefined, siteConfig(c.env).name)));

adminUi.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const expected = c.env.ADMIN_TOKEN;

  if (!expected || token !== expected) {
    return c.html(loginView('Invalid admin token', siteConfig(c.env).name), 401);
  }

  const headers = new Headers({ Location: '/admin' });
  setAdminCookie(headers, new URL(c.req.url).protocol === 'https:');
  return new Response(null, { status: 303, headers });
});

adminUi.post('/logout', (c) => {
  const headers = new Headers({ Location: '/admin/login' });
  clearAdminCookie(headers);
  return new Response(null, { status: 303, headers });
});

adminUi.use('*', requireAdmin());

adminUi.get('/', async (c) => {
  const stats = await dashboardStats(c.env.DB);
  return c.html(dashboardView(stats, siteConfig(c.env).name));
});

/** SPEC §16.2 — the import form. */
adminUi.get('/import', (c) => c.html(importView({}, siteConfig(c.env).name)));

adminUi.post('/import', async (c) => {
  const identity = c.get('adminIdentity');
  const siteName = siteConfig(c.env).name;

  const form = await c.req.parseBody();
  const urls = typeof form.urls === 'string' ? form.urls : '';

  try {
    const result = await importUrls(c.env, urls, identity.actor);
    return c.html(importView({ result }, siteName));
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError('BAD_REQUEST', String(err), 400);
    return c.html(importView({ error: `${appErr.code}: ${appErr.message}` }, siteName), appErr.status as 400);
  }
});

adminUi.get('/articles', async (c) => {
  const status = c.req.query('status');
  if (status && !STATUSES.includes(status as ArticleStatus)) {
    throw new AppError('BAD_REQUEST', `Unknown status: ${status}`, 400);
  }

  const articles = await listArticles(c.env.DB, {
    status: status as ArticleStatus | undefined,
    limit: clampInt(c.req.query('limit'), 50, 1, 100),
  });

  return c.html(articleListView({ articles, status: status ?? null, statuses: STATUSES }, siteConfig(c.env).name));
});

adminUi.get('/articles/:id', async (c) => {
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  const [jobs, events] = await Promise.all([listCrawlJobsForArticle(c.env.DB, id), listEvents(c.env.DB, id)]);
  return c.html(articleDetailView({ article, jobs, events }, siteConfig(c.env).name));
});

/** SPEC §16.4 — Retry. Re-publishes the queue message; crawling itself is Phase 2. */
adminUi.post('/articles/:id/retry', async (c) => {
  const identity = c.get('adminIdentity');
  const id = c.req.param('id');
  await retryCrawl(c.env, id, identity.actor);

  const headers = new Headers({ Location: `/admin/articles/${id}` });
  return new Response(null, { status: 303, headers });
});

adminUi.get('/jobs', async (c) => {
  const jobs = await listFailedJobs(c.env.DB, 100);
  return c.html(jobListView({ jobs }, siteConfig(c.env).name));
});
