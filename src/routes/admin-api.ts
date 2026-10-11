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
import { summarizeTeardown, teardownArchive } from '../services/teardown';
import { generateCover, generateMissingCovers } from '../services/cover';
import { readArticleDocument } from '../services/archive';
import { documentToPlainText } from '../types/article-document';
import { detectLanguage, languageSample } from '../lib/language';
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

/**
 * SPEC §15 — backfill the language badge for articles parsed before 0013.
 *
 * The detector runs inside the parser, so an article parsed before the column existed has
 * `lang IS NULL`. Re-parsing them would work but spends a full parse per article to compute
 * one field. This reads each article's stored document instead, takes the same
 * title-plus-body sample the parser does, and writes only `lang` — the parse output is
 * unchanged, so nothing about the article is recomputed.
 *
 * Idempotent: it selects `lang IS NULL`, so a second run finds nothing left to do.
 */
adminApi.post('/maintenance/backfill-language', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
  const limit = Number.isFinite(body.limit) ? Math.min(Math.max(Number(body.limit), 1), 200) : 50;

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, content_r2_key FROM articles
      WHERE lang IS NULL AND content_r2_key IS NOT NULL
      ORDER BY imported_at DESC LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: string; title: string | null; content_r2_key: string }>();

  let updated = 0;
  const failed: string[] = [];

  for (const row of results) {
    const document = await readArticleDocument(c.env.ARCHIVE, row.content_r2_key);
    if (!document) {
      failed.push(row.id);
      continue;
    }
    // The same sample the parser takes, so a backfilled article and a freshly parsed one
    // cannot disagree about what the language is.
    const lang = detectLanguage(languageSample(row.title, documentToPlainText(document)));
    await c.env.DB.prepare(`UPDATE articles SET lang = ?2 WHERE id = ?1`).bind(row.id, lang).run();
    updated += 1;
  }

  return c.json({ considered: results.length, updated, failed: failed.length, failedIds: failed });
});

/**
 * Generate a cover for one article (SPEC §15).
 *
 * A separate endpoint from `/media` on purpose: the media run downloads figures the
 * article already references, while this asks a model to make a new image. One is a
 * fetch, the other is a generation, and an operator wants to trigger them for different
 * reasons. Running this on an article that already has a body image is allowed but
 * pointless — the card would still prefer the author's own figure — so it is not refused;
 * the response says what happened and the caller decides.
 *
 * A generation that fails is a `200` with `ok: false` and the reason, not an error status,
 * for the same reason `/media` reports partial success that way: the model being unavailable
 * is a fact about this attempt, and the admin UI should show it rather than treat the whole
 * request as broken.
 */
adminApi.post('/articles/:id/cover', async (c) => {
  const id = c.req.param('id');
  const outcome = await generateCover(c.env, id);
  if (outcome.errorCode === 'NOT_FOUND') {
    throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);
  }
  return c.json({ articleId: id, ...outcome });
});

/**
 * Generate covers for every article that has none, newest first.
 *
 * ## Why this returns before the covers exist
 *
 * A cover takes tens of seconds of model time, and a synchronously-awaited batch of even
 * three exceeded the point at which the edge gives up — measured: `HTTP 000` after 61
 * seconds, with the covers generated anyway. The response was being lost, not the work.
 *
 * So the request answers immediately with what it is about to do, and the generation runs
 * via `waitUntil`, which is the mechanism for exactly this: work that must outlive the
 * response. The caller polls — `/api/admin/articles?status=…` shows the covers appearing —
 * or simply reloads the admin list.
 *
 * Bounded by `limit` because a model call per article costs money and time, and an operator
 * running this wants the recent articles covered rather than one request that spends the
 * whole archive. Run it again to continue; done articles are skipped by the idempotency
 * check in `generateCover`.
 */
adminApi.post('/covers/generate', (c) => {
  const body: { limit?: number } = {};
  // A body is optional here (the operation has a default), so a parse failure is not an
  // error — it just means "use the default".
  return c.req
    .json()
    .catch(() => ({}))
    .then((parsed: { limit?: number }) => {
      Object.assign(body, parsed);
      const limit = Number.isFinite(body.limit) ? Math.min(Math.max(Number(body.limit), 1), 50) : 10;

      c.executionCtx.waitUntil(
        generateMissingCovers(c.env, limit)
          .then((result) => {
            log.info('ai_success', {
              action: 'covers_generated',
              attempted: result.attempted,
              generated: result.generated,
              failed: result.failed,
            });
          })
          .catch((error: unknown) => {
            log.error('ai_failed', {
              error_code: 'COVER_BATCH_FAILED',
              error_message: error instanceof Error ? error.message : String(error),
            });
          }),
      );

      return c.json({ accepted: true, limit, status: 'generating' }, 202);
    });
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

/**
 * SPEC §8 — delete an article's R2 prefix.
 *
 * This exists so the smoke scripts can clean up after themselves. SPEC §8 makes raw
 * append-only, which is why deleting a D1 row deliberately leaves its captures
 * behind — but "append-only" is about not *overwriting* history, not about
 * forbidding a deliberate teardown of a fixture that was never real content.
 *
 * The guard is what makes this safe to expose, and it turns on whether a D1 row
 * still exists:
 *
 *   - A row that exists and is real content is refused. This is the case that
 *     matters: the archive must not be able to erase a capture nobody asked it to
 *     erase, and a real article can never become a teardown candidate by accident.
 *   - A row that exists and is one of this project's own fixtures is allowed,
 *     matched on the fixture handles plus the 13-digit id the import path
 *     normalises to.
 *   - No row at all is allowed, because that is the orphan case the endpoint
 *     exists for. Nothing in the application can reach such a prefix: the reading
 *     page, the admin surface and the search index all resolve an article from
 *     D1 first, so an unreachable prefix is storage that nothing can use.
 *
 * The orphan case has to be allowed, or cleanup could never run — a smoke run's
 * D1 row is exactly what gets deleted, and refusing to purge the prefix it left
 * behind is what produced 24 invisible ones in the first place.
 */
/**
 * The archive reset — every article, its media, and the taxonomy around it.
 *
 * Two endpoints rather than one, because the size of the operation has to be knowable
 * before it is committed to. `GET` reports what a reset would remove; `POST` performs
 * it. An operator cannot be asked to confirm an irreversible delete without being told
 * how much it is about to destroy, and reading afterwards would report zeroes.
 *
 * Guarded by the admin token like every other route, and by an explicit `confirm` string
 * that has to name the operation. The purge-prefix endpoint below guards against
 * *accidental* deletion by refusing a prefix whose row is real content; this is the
 * opposite case — a deliberate, total reset — so it needs a different guard, and the one
 * that fits is a spelled-out confirmation rather than a narrower permission.
 *
 * Reader accounts are not archive content and are not touched. See teardown.ts.
 */
adminApi.get('/maintenance/teardown', async (c) => {
  return c.json({ wouldRemove: await summarizeTeardown(c.env) });
});

adminApi.post('/maintenance/teardown', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
  // A string that cannot be sent by accident or arrive from a stale form. The route name
  // repeated back is the cheapest thing that is unambiguous.
  if (body.confirm !== 'teardown-archive') {
    throw new AppError(
      'BAD_REQUEST',
      'confirm must be the literal string "teardown-archive"; this deletes every article, all archived media, and the taxonomy',
      400,
    );
  }

  const result = await teardownArchive(c.env, c.get('adminIdentity').actor);
  return c.json(result);
});


adminApi.post('/maintenance/purge-prefix', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { articleId?: string; confirm?: string };
  const articleId = body.articleId ?? '';
  if (!articleId) throw new AppError('BAD_REQUEST', 'articleId is required', 400);

  // The prefix being deleted is derived from articleId, so a malformed id would
  // otherwise turn into a `articles/` or wider-prefix delete.
  if (!/^art_[a-z0-9]{16,32}$/.test(articleId)) {
    throw new AppError('BAD_REQUEST', `Refusing to purge: "${articleId}" is not an article id`, 400);
  }
  // Explicit confirmation, so a stray or replayed request cannot delete a prefix.
  if (body.confirm !== articleId) {
    throw new AppError(
      'BAD_REQUEST',
      'confirm must repeat the articleId; this deletes stored captures',
      400,
    );
  }

  const prefix = `articles/${articleId}/`;
  if ((await c.env.ARCHIVE.list({ prefix, limit: 1 })).objects.length === 0) {
    throw new AppError('NOT_FOUND', `No stored objects under ${prefix}`, 404);
  }

  const article = await c.env.DB.prepare(
    `SELECT id, slug, status, x_article_id FROM articles WHERE id = ?`,
  )
    .bind(articleId)
    .first<{ id: string; slug: string | null; status: string; x_article_id: string | null }>();

  const isFixture =
    article !== null &&
    FIXTURE_SLUG_PREFIXES.some((prefix) => article.slug?.startsWith(prefix) === true) &&
    isFixtureArticleId(article.x_article_id);

  // A row that exists and is not a fixture is real content, so its captures stay.
  // This is the case SPEC §8 is actually about, and it is why the endpoint cannot
  // simply purge whatever it is pointed at.
  if (article !== null && !isFixture) {
    throw new AppError(
      'BAD_REQUEST',
      `Refusing to purge: ${article.slug ?? articleId} is real content, not a smoke fixture.`,
      403,
    );
  }

  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await c.env.ARCHIVE.list({ prefix, limit: 1000, cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    for (const object of page.objects) {
      await c.env.ARCHIVE.delete(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  log.warn('publish', {
    article_id: articleId,
    actor: c.get('adminIdentity').actor,
    action: 'purged_r2_prefix',
    // A live fixture row is left in D1 on purpose: the purge removes stored
    // captures, and the row is the acceptance run's own bookkeeping.
    had_row: article !== null,
    objects,
    bytes,
  });

  return c.json({ articleId, prefix, objects, bytes, hadRow: article !== null });
});

/**
 * Slug prefixes belonging to this project's own fixtures, and nothing else.
 *
 * `karpathy-` / `someone-` are what the import acceptance script creates.
 * `demo_` is what the demo seeder creates. The seeder's rows use x_article_id
 * values in the 9000… range, which is what `removeDemoArticles` matches on, so the
 * two halves of the guard agree on the same fixtures.
 *
 * Real content arrives on a real handle: `haibaracrypto-`, `ray_codeproxy-`, and
 * anything else. None of those match, so a published article is refused.
 */
const FIXTURE_SLUG_PREFIXES = ['karpathy-', 'someone-', 'demo_'];

/**
 * The scripts build article ids from `Date.now()`, and the seeder uses the
 * 9000… range, so a fixture's x_article_id is a 13-digit snowflake-shaped string.
 * A real X article id is also 13 digits, so this only narrows the search — the slug
 * prefix is what actually separates a fixture from real content.
 */
function isFixtureArticleId(xArticleId: string | null): boolean {
  return xArticleId !== null && /^\d{13}$/.test(xArticleId);
}

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
