/**
 * SPEC §5 — URL import pipeline.
 *
 *   paste → normalize (§5.2) → dedup (§5.3) → D1 row + crawl job → Queue
 *
 * SPEC §34: this function must never wait for a crawl. It performs a handful of
 * D1 writes and a single queue `sendBatch`, then returns. Browser Run, the
 * Parser and Workers AI all happen later, in queue consumers.
 */

import { getArticleByCanonicalUrl, getArticleById } from '../db/articles';
import { listCrawlJobsForArticle, recordRetryAttempt } from '../db/jobs';
import { recordEvent } from '../db/events';
import { newId } from '../lib/ids';
import { log } from '../lib/logger';
import type { ImportErrorCode } from '../lib/errors';
import { AppError } from '../lib/errors';
import type { JobMessage } from '../jobs/types';
import { buildArticleSlug, normalizeArticleUrl, splitUrlInput } from '../lib/url';

export interface ImportOutcome {
  /** SPEC §5.3 — `duplicate` returns the existing article, never a new one. */
  status: 'created' | 'duplicate' | 'failed';
  input: string;
  canonicalUrl?: string;
  articleId?: string;
  jobId?: string;
  code?: ImportErrorCode;
  message?: string;
}

export interface ImportResult {
  created: number;
  duplicates: number;
  failed: number;
  /** SPEC §22 response shape: `{ id, status }` per created article. */
  articles: Array<{ id: string; status: string; canonicalUrl: string; jobId: string }>;
  outcomes: ImportOutcome[];
}

/** D1 accepts at most 100 statements per `batch()` call; keep a safety margin. */
const MAX_STATEMENTS_PER_BATCH = 90;
const STATEMENTS_PER_ARTICLE = 3; // article + crawl_job + curation_event
const QUEUE_SEND_BATCH_LIMIT = 100;

export async function importUrls(env: Env, rawInput: string, actor: string): Promise<ImportResult> {
  const candidates = splitUrlInput(rawInput);
  log.info('import_received', { count: candidates.length, actor });

  if (candidates.length === 0) {
    throw new AppError('EMPTY_INPUT', 'No URLs found in the pasted input', 400);
  }

  const maxUrls = Number(env.MAX_IMPORT_URLS ?? 200);
  if (Number.isFinite(maxUrls) && candidates.length > maxUrls) {
    throw new AppError('TOO_MANY_URLS', `Too many URLs: ${candidates.length} (max ${maxUrls})`, 400);
  }

  const outcomes: ImportOutcome[] = [];
  const messages: JobMessage[] = [];
  const pendingStatements: D1PreparedStatement[] = [];
  const pendingArticles: Array<{ articleId: string; jobId: string; canonicalUrl: string }> = [];

  // A Map, not a Set: the same URL pasted twice in one batch must be reported as
  // a duplicate rather than creating two rows.
  const seenInBatch = new Map<string, { articleId: string; jobId: string }>();

  for (const input of candidates) {
    const normalized = normalizeArticleUrl(input);
    if (!normalized.ok) {
      outcomes.push({ status: 'failed', input, code: normalized.code, message: normalized.message });
      log.info('import_rejected', { input, error_code: normalized.code, error_message: normalized.message });
      continue;
    }

    const { sourceUrl, canonicalUrl, xArticleId, username } = normalized.value;

    const inBatch = seenInBatch.get(canonicalUrl);
    if (inBatch) {
      outcomes.push({
        status: 'duplicate',
        input,
        canonicalUrl,
        articleId: inBatch.articleId,
        jobId: inBatch.jobId,
      });
      continue;
    }

    const existing = await getArticleByCanonicalUrl(env.DB, canonicalUrl);
    if (existing) {
      seenInBatch.set(canonicalUrl, { articleId: existing.id, jobId: '' });
      outcomes.push({
        status: 'duplicate',
        input,
        canonicalUrl,
        articleId: existing.id,
      });
      log.info('import_duplicate', { article_id: existing.id, canonical_url: canonicalUrl });
      continue;
    }

    const articleId = newId('art');
    const jobId = newId('job');
    const slug = buildArticleSlug(username, xArticleId);
    const now = Date.now();

    pendingStatements.push(
      env.DB.prepare(
        `INSERT INTO articles (id, source_url, canonical_url, x_article_id, slug, title, status, imported_at,
                               display_mode, featured, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 'full', 0, ?7, ?7)`,
      ).bind(articleId, sourceUrl, canonicalUrl, xArticleId, slug, `@${username} on X`, now),

      env.DB.prepare(
        `INSERT INTO crawl_jobs (id, article_id, job_type, status, attempt_count, deliveries, created_at, updated_at)
         VALUES (?1, ?2, 'crawl', 'queued', 0, 0, ?3, ?3)`,
      ).bind(jobId, articleId, now),

      env.DB.prepare(
        `INSERT INTO curation_events (id, article_id, action, actor, note, created_at)
         VALUES (?1, ?2, 'import', ?3, ?4, ?5)`,
      ).bind(newId('evt'), articleId, actor, canonicalUrl, now),
    );

    seenInBatch.set(canonicalUrl, { articleId, jobId });
    pendingArticles.push({ articleId, jobId, canonicalUrl });
    messages.push({ jobId, articleId, type: 'crawl', attempt: 1, createdAt: now });
    outcomes.push({ status: 'created', input, canonicalUrl, articleId, jobId });

    if (pendingStatements.length >= MAX_STATEMENTS_PER_BATCH) {
      await flush(env, pendingStatements);
      pendingStatements.length = 0;
    }
  }

  if (pendingStatements.length > 0) {
    await flush(env, pendingStatements);
  }

  await publishJobs(env, messages);

  const result: ImportResult = {
    created: pendingArticles.length,
    duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    articles: pendingArticles.map((a) => ({
      id: a.articleId,
      status: 'queued',
      canonicalUrl: a.canonicalUrl,
      jobId: a.jobId,
    })),
    outcomes,
  };

  log.info('import_created', {
    created: result.created,
    duplicates: result.duplicates,
    failed: result.failed,
  });

  return result;
}

async function flush(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await env.DB.batch(statements);
  } catch (err) {
    // A UNIQUE violation here means a concurrent import won the race (SPEC §5.3).
    // The batch is atomic, so nothing was written; surface it rather than
    // pretending the article was created.
    log.error('import_rejected', {
      error_code: 'IMPORT_BATCH_FAILED',
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function publishJobs(env: Env, messages: JobMessage[]): Promise<void> {
  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    const chunk = messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT);
    await env.ARTICLE_INGEST_QUEUE.sendBatch(chunk.map((body) => ({ body })));
  }

  log.info('queue_published', { queue: 'article-ingest', count: messages.length });
}

/** Admin "Retry" (SPEC §16.4) re-uses the same enqueue path. */
export async function enqueueCrawlJob(env: Env, jobId: string, articleId: string, attempt: number): Promise<void> {
  const message: JobMessage = { jobId, articleId, type: 'crawl', attempt, createdAt: Date.now() };
  await env.ARTICLE_INGEST_QUEUE.send(message);
  log.info('queue_published', { queue: 'article-ingest', job_id: jobId, article_id: articleId, attempt });
}

/**
 * SPEC §16.4 — Retry.
 *
 * Phase 1 meaning: put the newest crawl job back on the queue and bump its
 * attempt counter. Phase 2 attaches the actual Browser Run fetch.
 */
export async function retryCrawl(env: Env, articleId: string, actor: string): Promise<{ jobId: string; attempt: number }> {
  const article = await getArticleById(env.DB, articleId);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${articleId}`, 404);

  const jobs = await listCrawlJobsForArticle(env.DB, articleId, 1);
  const job = jobs[0];
  if (!job) throw new AppError('NOT_FOUND', `No crawl job for article: ${articleId}`, 404);

  const attempt = job.attempt_count + 1;
  await recordRetryAttempt(env.DB, job.id, attempt);
  await recordEvent(env.DB, articleId, 'retry', actor, `attempt ${attempt}`);
  await enqueueCrawlJob(env, job.id, articleId, attempt);

  return { jobId: job.id, attempt };
}
