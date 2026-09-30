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
import { crawlArticle, readRawArchive } from '../services/crawl';
import { parseArticle, PARSER_VERSION } from '../services/parse';
import { downloadArticleMedia, findOrphanedPrefixes, mediaSummary } from '../services/media';
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

/**
 * SPEC §16.4 — "Retry with Browser Session".
 *
 * Runs the crawl synchronously instead of publishing a queue message, so an
 * operator waiting in front of the admin UI sees the real outcome (including the
 * specific §25 error code) instead of polling a job that may retry for a day.
 */
adminApi.post('/articles/:id/crawl', async (c) => {
  const identity = c.get('adminIdentity');
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  const outcome = await crawlArticle(c.env, {
    articleId: id,
    url: article.canonical_url,
    fallbackUsername: article.author_username,
    actor: identity.actor,
  });

  const jobs = await listCrawlJobsForArticle(c.env.DB, id, 1);
  const job = jobs[0];
  if (job) {
    // Only record an error when there is one: writing a placeholder code on
    // success made a healthy job read as `success(UNEXPECTED)`.
    await updateJobStatus(
      c.env.DB,
      job.id,
      outcome.ok ? 'success' : 'failed',
      outcome.ok ? undefined : { code: outcome.errorCode ?? 'UNEXPECTED', message: outcome.errorMessage ?? '' },
    );
  }

  return c.json({
    articleId: id,
    ok: outcome.ok,
    result: outcome.result,
    title: outcome.title,
    bodyChars: outcome.bodyChars,
    browserMsUsed: outcome.browserMsUsed,
    htmlError: outcome.htmlError ?? null,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
  });
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
 * SPEC §16.4 — "View Raw HTML" and "View Error".
 *
 * Returns the archived capture, not a live fetch: SPEC §27 requires the raw
 * archive to be enough to re-run the Parser without touching X again.
 */
adminApi.get('/articles/:id/raw', async (c) => {
  const article = await getArticleById(c.env.DB, c.req.param('id'));
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${c.req.param('id')}`, 404);

  if (!article.raw_r2_key) {
    return c.json({
      articleId: article.id,
      archived: false,
      message: 'No raw archive yet. The crawl has not completed for this article.',
    });
  }

  const archive = await readRawArchive(c.env.ARCHIVE, article.raw_r2_key);
  return c.json({
    articleId: article.id,
    archived: true,
    rawR2Key: article.raw_r2_key,
    metadata: archive.metadata,
    markdown: c.req.query('format') === 'markdown' ? archive.markdown : undefined,
    html: c.req.query('format') === 'html' ? archive.html : undefined,
    // Byte counts only, so listing a capture stays cheap.
    markdownBytes: archive.markdown?.length ?? 0,
    htmlBytes: archive.html?.length ?? 0,
  });
});

/**
 * SPEC §38 Phase 3 — run the Parser now.
 *
 * SPEC §27: this reads only the raw archive, so it never touches X and costs no
 * browser time. That is what makes re-parsing the right fix when the Parser
 * improves.
 */
adminApi.post('/articles/:id/parse', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const id = c.req.param('id');

  const outcome = await parseArticle(c.env, id);

  const jobs = await listCrawlJobsForArticle(c.env.DB, id, 20);
  const parseJob = jobs.find((j) => j.job_type === 'parse');
  if (parseJob) {
    await updateJobStatus(
      c.env.DB,
      parseJob.id,
      outcome.ok ? 'success' : 'failed',
      outcome.ok ? undefined : { code: outcome.errorCode ?? 'UNEXPECTED', message: outcome.errorMessage ?? '' },
    );
  }

  if (!outcome.ok) {
    const { ok, ...rest } = outcome;
    return c.json({ articleId: id, ok, ...rest }, 400);
  }

  const article = await getArticleById(c.env.DB, id);
  log.info('publish', { article_id: id, actor, action: 'parsed', blocks: outcome.blockCount });
  const { ok, ...rest } = outcome;
  return c.json({ articleId: id, ok, ...rest, contentR2Key: article?.content_r2_key ?? null });
});

/**
 * SPEC §10 — download every image into R2, now.
 *
 * Unlike the crawl and the parse, this does reach out to X's CDN — but only to
 * take a copy. After it runs, the reading page no longer depends on that CDN at
 * all, and re-running it is how a previously failed image is retried.
 */
adminApi.post('/articles/:id/media', async (c) => {
  const actor = c.get('adminIdentity').actor;
  const id = c.req.param('id');

  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  if (!article.content_r2_key) {
    throw new AppError(
      'BAD_REQUEST',
      'No parsed document yet. Run the Parser first — media is derived from the ArticleDocument.',
      409,
    );
  }

  const outcome = await downloadArticleMedia(c.env, id);
  const summary = await mediaSummary(c.env, id);

  log.info('publish', {
    article_id: id,
    actor,
    action: 'media_downloaded',
    ready: outcome.ready,
    failed: outcome.failed,
  });

  // A partial result is still a completed request: the per-image state is in the
  // response and in media_objects. Reporting 400 would make the admin UI treat a
  // single deleted image as a broken endpoint.
  return c.json({ articleId: id, ...outcome, summary });
});

/** SPEC §10 — per-image state, so the admin can see what is and is not archived. */
adminApi.get('/articles/:id/media', async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT id, position, kind, source_url, r2_key, width, height, alt_text, status,
            content_type, byte_size, error_code, error_message, attempt_count, fetched_at
       FROM media_objects
      WHERE article_id = ?
      ORDER BY kind ASC, position ASC`,
  )
    .bind(id)
    .all<Record<string, unknown>>();

  return c.json({
    articleId: id,
    summary: await mediaSummary(c.env, id),
    images: results.map((row) => ({
      imageId: row.id,
      position: row.position,
      kind: row.kind,
      status: row.status,
      r2Key: row.r2_key,
      servedFrom: row.r2_key ? `/media/${row.id}` : row.source_url,
      width: row.width,
      height: row.height,
      contentType: row.content_type,
      byteSize: row.byte_size,
      altText: row.alt_text,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      attempts: row.attempt_count,
      fetchedAt: row.fetched_at,
    })),
  });
});

/**
 * SPEC §8 / §10 — R2 storage report.
 *
 * SPEC §8 requires raw to be append-only, so deleting an article row leaves its
 * captures behind on purpose. This is where that becomes visible: it lists every
 * prefix under `articles/` and marks the ones no D1 row claims. Without it, a
 * smoke run quietly accrues prefixes that nobody can see and nobody can account
 * for — which is exactly how 24 of them went unnoticed.
 *
 * Read-only on purpose. There is no delete here: this endpoint is for seeing the
 * state, and the decision about an append-only archive is a human one.
 */
adminApi.get('/storage', async (c) => {
  const listed = await c.env.ARCHIVE.list({ prefix: 'articles/', limit: 1000 });

  let objects = listed.objects.length;
  let bytes = listed.objects.reduce((sum, o) => sum + o.size, 0);
  let cursor = listed.truncated ? listed.cursor : undefined;
  while (cursor) {
    const page = await c.env.ARCHIVE.list({ prefix: 'articles/', limit: 1000, cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  }

  const orphaned = await findOrphanedPrefixes(c.env);

  const media = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes
       FROM media_objects GROUP BY status`,
  )
    .all<{ status: string; n: number; bytes: number }>();

  return c.json({
    total: { objects, bytes },
    media: media.results.map((r) => ({ status: r.status, count: r.n, bytes: r.bytes })),
    // SPEC §8 — these are expected after a smoke run. Reported, never auto-deleted.
    orphanedPrefixes: orphaned,
    orphanedTotal: {
      prefixes: orphaned.length,
      objects: orphaned.reduce((s, o) => s + o.objects, 0),
      bytes: orphaned.reduce((s, o) => s + o.bytes, 0),
    },
  });
});

/** SPEC §16.4 — crawl errors, straight from the job row. */
adminApi.get('/articles/:id/errors', async (c) => {
  const jobs = await listCrawlJobsForArticle(c.env.DB, c.req.param('id'), 10);
  return c.json({
    errors: jobs
      .filter((j) => j.error_code || j.status === 'failed' || j.status === 'retrying')
      .map((j) => ({
        jobId: j.id,
        jobType: j.job_type,
        status: j.status,
        attempts: j.attempt_count,
        code: j.error_code,
        message: j.error_message,
        updatedAt: new Date(j.updated_at).toISOString(),
      })),
  });
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
