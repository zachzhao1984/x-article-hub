/**
 * SPEC §16 — Admin UI routes.
 *
 * Server-rendered HTML. The import form posts to itself so the whole flow works
 * with JavaScript disabled, which is also the easiest thing to smoke-test.
 */

import { Hono, type Context } from 'hono';
import type { AdminIdentity } from '../middleware/admin-auth';
import { requireAdmin, setAdminCookie, clearAdminCookie, timingSafeEqual } from '../middleware/admin-auth';
import { siteConfig } from '../config/site';
import { log } from '../lib/logger';
import { refreshRanking } from '../services/ranking-refresh';
import { deleteArticleEverywhere } from '../services/delete-article';
import { dashboardStats } from '../db/stats';
import { getArticleById, listArticles } from '../db/articles';
import { listCrawlJobsForArticle, listFailedJobs, updateJobStatus } from '../db/jobs';
import { listEvents } from '../db/events';
import { listCategories } from '../db/categories';
import { importUrls, retryCrawl } from '../services/import';
import { crawlArticle, readRawArchive } from '../services/crawl';
import { parseArticle } from '../services/parse';
import { translateArticleBatch } from '../services/translate';
import { downloadArticleMedia, listArticleMedia } from '../services/media';
import {
  archiveArticle,
  overrideCategory,
  publishArticle,
  rejectArticle,
  restoreDisplay,
  setFeatured,
  takedownArticle,
} from '../services/publish';
import { AppError } from '../lib/errors';
import { clampInt } from '../lib/http';
import type { ArticleStatus, DisplayMode } from '../jobs/types';
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

/** SPEC §16.4 — the raw archive summary, without pulling megabytes into the page. */
async function summarizeRawArchive(
  bucket: R2Bucket,
  rawR2Key: string | null,
): Promise<{ archived: boolean; markdownBytes: number; htmlBytes: number; r2Key: string | null }> {
  if (!rawR2Key) return { archived: false, markdownBytes: 0, htmlBytes: 0, r2Key: null };

  const archive = await readRawArchive(bucket, rawR2Key);
  return {
    archived: archive.metadata !== null,
    markdownBytes: archive.markdown?.length ?? 0,
    htmlBytes: archive.html?.length ?? 0,
    r2Key: rawR2Key,
  };
}

// The login page is the only route that is not behind requireAdmin().
adminUi.get('/login', (c) => c.html(loginView(undefined, siteConfig(c.env).name)));

adminUi.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const secret = c.env.ADMIN_TOKEN;

  if (!secret || !token || !timingSafeEqual(token, secret)) {
    return c.html(loginView('Invalid admin token', siteConfig(c.env).name), 401);
  }

  const headers = new Headers({ Location: '/admin' });
  await setAdminCookie(headers, secret, new URL(c.req.url).protocol === 'https:');
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

/**
 * SPEC §21 — run the ranking refresh on demand.
 *
 * The cron does this every 30 minutes, so the button is for the moment right after an
 * import, when waiting half an hour to see `/trending` move would be the only alternative.
 * It runs the same function the cron does, so there is exactly one implementation of what a
 * score means.
 */
adminUi.post('/ranking/refresh', async (c) => {
  const result = await refreshRanking(c.env);
  const stats = await dashboardStats(c.env.DB);
  return c.html(
    dashboardView(
      { ...stats, refreshed: { scored: result.scored, withoutMetrics: result.withoutMetrics } },
      siteConfig(c.env).name,
    ),
  );
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

  return c.html(
    articleListView(
      {
        articles,
        status: status ?? null,
        statuses: STATUSES,
        // SPEC §16.3 — which row action just ran. Passed through as-is; the view matches it
        // against a fixed map rather than rendering it, so a crafted `?notice=` cannot put
        // text on the page.
        notice: c.req.query('notice') ?? null,
        // SPEC §16 — what a delete just removed, carried in the query string the handler
        // redirected with. The counts are read as numbers and re-emitted; a missing or
        // unparseable value falls back to 0 rather than rendering "NaN objects".
        deleted:
          c.req.query('deleted') === '1'
            ? {
                slug: c.req.query('slug') ?? null,
                objects: clampInt(c.req.query('objects'), 0, 0, Number.MAX_SAFE_INTEGER),
                bytes: clampInt(c.req.query('bytes'), 0, 0, Number.MAX_SAFE_INTEGER),
              }
            : undefined,
      },
      siteConfig(c.env).name,
    ),
  );
});

adminUi.get('/articles/:id', async (c) => {
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  const [jobs, events, raw, media, categories] = await Promise.all([
    listCrawlJobsForArticle(c.env.DB, id),
    listEvents(c.env.DB, id),
    summarizeRawArchive(c.env.ARCHIVE, article.raw_r2_key),
    // SPEC §10 — per-image state, so it is visible which figures are archived
    // and which are still hotlinking X.
    listArticleMedia(c.env.DB, id),
    // SPEC §13.5 — the picker's options. Without this the category control cannot be
    // rendered at all, which is exactly how the API's category endpoint ended up
    // reachable by nothing.
    listCategories(c.env.DB),
  ]);
  const parsed = c.req.query('parsed');
  const blocks = Number(c.req.query('blocks') ?? '0') || 0;
  const notice = parsed
    ? `Parsed (${parsed}) — ${blocks} blocks. Refresh the article page to read it.`
    : c.req.query('translated')
      ? c.req.query('translated') === 'complete'
        ? 'Chinese translation is ready. Open the article and choose 中文.'
        : `Chinese translation in progress: ${clampInt(c.req.query('count'), 0, 0, 10000)} of ${clampInt(c.req.query('total'), 0, 0, 10000)} text segments. Continue translating to resume.`
    : c.req.query('media')
      ? `Media run ${c.req.query('media')} — ${c.req.query('ready') ?? 0} archived, ${c.req.query('failed') ?? 0} still on X's CDN.`
      : c.req.query('notice') === 'category-saved'
        ? 'Category saved. It counts on the category page and in the header chips immediately.'
        : null;

  const error = c.req.query('error');
  const errorMessage =
    error === 'takedown-reason-missing'
      ? 'A takedown needs a reason — that is what the reader sees.'
      : error === 'unknown-category'
        ? 'That category does not exist. The article was left untouched — reload to pick from the current list.'
        : error === 'delete-confirm-mismatch'
          ? 'Delete needs the article slug typed exactly. Nothing was removed — reload and try again if you meant it.'
          : error ?? null;

  return c.html(
    articleDetailView(
      {
        article,
        jobs,
        events,
        categories: categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
        raw,
        parsed: {
          contentR2Key: article.content_r2_key,
          blockCount: article.block_count,
          wordCount: article.word_count,
          parserVersion: article.parser_version,
        },
        media,
        notice,
        error: errorMessage,
      },
      siteConfig(c.env).name,
    ),
  );
});

/** SPEC §16.4 — Retry. Re-publishes the queue message. */
adminUi.post('/articles/:id/retry', async (c) => {
  const identity = c.get('adminIdentity');
  const id = c.req.param('id');
  await retryCrawl(c.env, id, identity.actor);

  const headers = new Headers({ Location: `/admin/articles/${id}` });
  return new Response(null, { status: 303, headers });
});

/** SPEC §16.4 — "Retry with Browser Session": crawl synchronously, report inline. */
adminUi.post('/articles/:id/crawl', async (c) => {
  const identity = c.get('adminIdentity');
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);

  if (article) {
    const outcome = await crawlArticle(c.env, {
      articleId: id,
      url: article.canonical_url,
      fallbackUsername: article.author_username,
      actor: identity.actor,
    });
    const jobs = await listCrawlJobsForArticle(c.env.DB, id, 1);
    const job = jobs[0];
    if (job) {
      await updateJobStatus(c.env.DB, job.id, outcome.ok ? 'success' : 'failed', {
        code: outcome.errorCode ?? 'UNEXPECTED',
        message: outcome.errorMessage ?? '',
      });
    }
  }

  const headers = new Headers({ Location: `/admin/articles/${id}` });
  return new Response(null, { status: 303, headers });
});

/** SPEC §38 Phase 3 — parse the raw archive now. Free: no browser time, no X traffic. */
adminUi.post('/articles/:id/parse', async (c) => {
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

  const headers = new Headers({
    Location: outcome.ok
      ? `/admin/articles/${id}?parsed=${outcome.result}&blocks=${outcome.blockCount ?? 0}`
      : `/admin/articles/${id}?error=${encodeURIComponent(outcome.errorMessage ?? 'parse failed')}`,
  });
  return new Response(null, { status: 303, headers });
});

adminUi.post('/articles/:id/translate', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await translateArticleBatch(c.env, id);
    const query = new URLSearchParams({ translated: result.done ? 'complete' : 'progress', count: String(result.translated), total: String(result.total) });
    return c.redirect(`/admin/articles/${id}?${query}`, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.redirect(`/admin/articles/${id}?error=${encodeURIComponent(message)}`, 303);
  }
});

/**
 * SPEC §10 — download every image into R2, synchronously.
 *
 * Unlike Parse, this does reach X's CDN — but only to take a copy. After it
 * runs the reading page no longer depends on that CDN, and running it again is
 * how a previously failed image gets retried.
 */
adminUi.post('/articles/:id/media', async (c) => {
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${id}`, 404);

  if (!article.content_r2_key) {
    const headers = new Headers({
      Location: `/admin/articles/${id}?error=${encodeURIComponent(
        'No parsed document yet — run Parse first, media is derived from the ArticleDocument.',
      )}`,
    });
    return new Response(null, { status: 303, headers });
  }

  const outcome = await downloadArticleMedia(c.env, id);

  const jobs = await listCrawlJobsForArticle(c.env.DB, id, 20);
  const mediaJob = jobs.find((j) => j.job_type === 'media');
  if (mediaJob) {
    // A partial result is still a completed run: SPEC §10 says a failed image
    // must not fail its Article, and the per-image state is on the detail page.
    await updateJobStatus(c.env.DB, mediaJob.id, 'success', outcome.ok ? undefined : {
      code: 'MEDIA_PARTIAL',
      message: `${outcome.failures.length} image(s) fell back to X's CDN.`,
    });
  }

  const query = new URLSearchParams({
    media: outcome.ok ? 'complete' : 'partial',
    ready: String(outcome.ready),
    failed: String(outcome.failed),
  });

  const headers = new Headers({ Location: `/admin/articles/${id}?${query}` });
  return new Response(null, { status: 303, headers });
});

/**
 * SPEC §16.3 — the curation actions.
 *
 * The API endpoints existed but had no UI, which meant the review workflow in
 * §16.3 could not actually be performed from the admin. Each handler maps to one
 * validated transition in src/services/publish.ts.
 */
/**
 * SPEC §16 — hard delete, from the article list or the detail page.
 *
 * `POST` with a required, repeated confirmation field. The dialog in the browser is a
 * guard against a misclick, not a security boundary — anything can post this URL — so the
 * server demands the article id spelled out a second time. That is the same shape the
 * existing `purge-prefix` endpoint uses, and it is the difference between an accidental
 * delete and a deliberate one.
 *
 * The confirmation is the article's **slug**, not its id: the id is not visible anywhere in
 * the UI, so an operator who wants to be sure they are deleting what they think they are
 * would have to copy it out of the URL. The slug is the thing they can read off the row.
 */
adminUi.post('/articles/:id/delete', async (c) => {
  const id = c.req.param('id');
  const identity = c.get('adminIdentity');
  const form = await c.req.parseBody();

  const article = await getArticleById(c.env.DB, id);
  const expected = article?.slug ?? id;

  if (typeof form.confirm !== 'string' || form.confirm.trim() !== expected) {
    log.warn('article_delete_refused', {
      article_id: id,
      actor: identity.actor,
      // The submitted value is not logged: it is compared against a slug, and there is
      // nothing to learn from a near-miss beyond the fact that it was one.
      reason: 'confirmation did not match',
    });
    return redirectToArticle(c, id, 'delete-confirm-mismatch');
  }

  const result = await deleteArticleEverywhere(c.env, id, identity.actor);

  // Redirect to the list, not the article: the detail page it would return to no longer
  // exists, and a 404 after a successful action reads as a failure.
  const params = new URLSearchParams({
    deleted: '1',
    objects: String(result.objects),
    bytes: String(result.bytes),
    ...(result.slug ? { slug: result.slug } : {}),
  });
  return new Response(null, {
    status: 303,
    headers: { Location: `/admin/articles?${params.toString()}` },
  });
});

adminUi.post('/articles/:id/publish', async (c) => {
  const id = c.req.param('id');
  await publishArticle(c.env, id, c.get('adminIdentity').actor);

  const fromList = listReturn(c, await c.req.parseBody(), 'published');
  if (fromList) return fromList;
  return redirectToArticle(c, id);
});

adminUi.post('/articles/:id/reject', async (c) => {
  await rejectArticle(c.env, c.req.param('id'), c.get('adminIdentity').actor);
  return redirectToArticle(c, c.req.param('id'));
});

adminUi.post('/articles/:id/archive', async (c) => {
  await archiveArticle(c.env, c.req.param('id'), c.get('adminIdentity').actor);
  return redirectToArticle(c, c.req.param('id'));
});

/**
 * SPEC §16.3 — set the category from the admin page.
 *
 * A plain form POST rather than a fetch to `PATCH /api/admin/articles/:id`, for the
 * same reason the rest of this surface is forms: it works with scripting off, and a
 * control that needs JavaScript is a control that silently does nothing for anyone who
 * has it disabled.
 *
 * The empty value is the clear action, not a category called "". `overrideCategory`
 * validates whatever arrives against the live category list, so an unknown id is a 400
 * with a message rather than a stored value no join can match.
 */
adminUi.post('/articles/:id/category', async (c) => {
  const form = await c.req.parseBody();
  const raw = typeof form.categoryId === 'string' ? form.categoryId.trim() : '';
  const id = c.req.param('id');

  try {
    await overrideCategory(c.env, id, c.get('adminIdentity').actor, raw === '' ? null : raw);
  } catch (error) {
    if (error instanceof AppError && error.code === 'BAD_REQUEST') {
      return redirectToArticle(c, id, 'unknown-category');
    }
    throw error;
  }
  return redirectToArticle(c, id, undefined, 'category-saved');
});

adminUi.post('/articles/:id/featured', async (c) => {
  const id = c.req.param('id');
  const article = await getArticleById(c.env.DB, id);
  // The toggle reads the stored value and inverts it. Taking the target state from the
  // request instead would let a stale page flip an article twice — a form rendered before
  // somebody else featured it would unfeature it back.
  const nowFeatured = article?.featured !== 1;
  await setFeatured(c.env, id, c.get('adminIdentity').actor, nowFeatured);

  const fromList = listReturn(c, await c.req.parseBody(), nowFeatured ? 'featured' : 'unfeatured');
  if (fromList) return fromList;
  return redirectToArticle(c, id);
});

/** SPEC §37 — takedown requires a reason, enforced in the service too. */
adminUi.post('/articles/:id/takedown', async (c) => {
  const form = await c.req.parseBody();
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  const id = c.req.param('id');
  if (!reason) return redirectToArticle(c, id, 'takedown-reason-missing');

  await takedownArticle(c.env, id, c.get('adminIdentity').actor, reason);
  return redirectToArticle(c, id);
});

/** SPEC §37 — restore visibility. */
adminUi.post('/articles/:id/restore', async (c) => {
  const form = await c.req.parseBody();
  const mode = (typeof form.displayMode === 'string' ? form.displayMode : 'full') as DisplayMode;
  await restoreDisplay(c.env, c.req.param('id'), c.get('adminIdentity').actor, mode);
  return redirectToArticle(c, c.req.param('id'));
});

/**
 * Post-redirect-get back to the article page.
 *
 * `notice` and `error` are separate query keys rather than one `message`, because the
 * page renders them differently — a confirmation in the green banner, a refusal in the
 * red one — and overloading a single key means a success has to be styled as a failure
 * or the other way round. The `?` guard keeps an absent value from leaving a bare
 * `?notice=` behind for the view to render as literal text.
 */
/**
 * SPEC §16.3 — where a row action returns to.
 *
 * The quick actions on the article list post to routes shared with the detail page, and the
 * two want different destinations: the detail page's own buttons should stay on the article,
 * while a button pressed on row 7 of a filtered list has to come back to that list. The
 * list's forms send `from=list`; the detail page's do not.
 *
 * Returns null when the request did not come from the list, so the caller can fall through
 * to its own redirect. That shape rather than a default keeps the decision at the call site,
 * where the detail page's destination is known.
 *
 * The `notice` names which action ran, so one banner can serve every row action instead of a
 * flag per action. The status filter is forwarded because the article may have just left the
 * filter the editor was looking at — `publish` moves `review` to `published`, and a list
 * would otherwise silently lose the row that changed.
 */
function listReturn(c: Context, form: Record<string, unknown>, notice: string): Response | null {
  if (form.from !== 'list') return null;
  const status = typeof form.status === 'string' && form.status ? form.status : null;
  // Rebuilt from a fixed set plus one validated-looking value — never from the submitted
  // form as a whole, because an attacker-chosen path in a Location header is an open
  // redirect and only the status decides what the editor was looking at.
  const params = new URLSearchParams({ notice });
  if (status) params.set('status', status);
  return new Response(null, { status: 303, headers: { Location: `/admin/articles?${params.toString()}` } });
}

function redirectToArticle(c: Context, id: string, error?: string, notice?: string): Response {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (notice) params.set('notice', notice);
  const query = params.toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `/admin/articles/${id}${query ? `?${query}` : ''}` },
  });
}

adminUi.get('/jobs', async (c) => {
  const jobs = await listFailedJobs(c.env.DB, 100);
  return c.html(jobListView({ jobs }, siteConfig(c.env).name));
});
