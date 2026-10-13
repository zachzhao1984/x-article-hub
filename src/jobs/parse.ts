/**
 * SPEC §38 Phase 3 — the parse job.
 *
 * SPEC §19 requires idempotency: `parseArticle` is a no-op when the parser
 * version and the archive are unchanged, so redelivery is safe.
 */

import type { JobMessage, JobType } from './types';
import { log } from '../lib/logger';
import { getArticleById } from '../db/articles';
import { getCrawlJob, updateJobStatus } from '../db/jobs';
import { newId } from '../lib/ids';
import { parseArticle, PARSER_VERSION } from '../services/parse';

export async function handleParse(message: JobMessage, env: Env): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    await updateJobStatus(env.DB, message.jobId, 'skipped', {
      code: 'NOT_FOUND',
      message: 'Article row no longer exists',
    });
    log.warn('parse_failed', { article_id: message.articleId, job_id: message.jobId, error_code: 'NOT_FOUND' });
    return;
  }

  const job = await getCrawlJob(env.DB, message.jobId);
  if (job && (job.status === 'success' || job.status === 'skipped')) {
    log.info('parse_success', { article_id: message.articleId, job_id: message.jobId, status: 'already_done' });
    return;
  }

  const outcome = await parseArticle(env, message.articleId);

  if (!outcome.ok) {
    // A missing raw archive means the crawl has not finished (or never will).
    // Retrying is worthwhile only in that case; a parser crash is not.
    const retryable = outcome.errorCode === 'RAW_MISSING';
    await updateJobStatus(env.DB, message.jobId, retryable ? 'retrying' : 'failed', {
      code: outcome.errorCode ?? 'PARSER_FAILED',
      message: outcome.errorMessage ?? '',
    });
    log.error('parse_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      attempt: message.attempt,
      error_code: outcome.errorCode ?? 'PARSER_FAILED',
      error_message: outcome.errorMessage ?? '',
    });
    return;
  }

  await updateJobStatus(env.DB, message.jobId, 'success');

  // SPEC §10 — media is derived from the ArticleDocument, so it can only start
  // once the Parser has written one. Enqueuing from here rather than from the
  // crawl keeps the ordering guarantee in one place: there is no path that
  // produces a document without also scheduling the download.
  await enqueueProcessJob(env, message.articleId, 'media');

  // SPEC §13 — the classifier reads the plain text the parser just wrote, so it has the
  // same ordering constraint as media and is scheduled from the same place. Enqueuing
  // from here means there is no path that produces a document without also asking for a
  // category, which is what makes "every article gets classified" true by construction
  // rather than by remembering to call it.
  await enqueueProcessJob(env, message.articleId, 'ai');

  log.info('parse_success', {
    article_id: message.articleId,
    job_id: message.jobId,
    parser_version: PARSER_VERSION,
    outcome: outcome.result,
    block_count: outcome.blockCount,
    word_count: outcome.wordCount,
  });
}

/**
 * SPEC §19 — one open job of each type per article, so a redelivered parse cannot stack
 * duplicate downloads or duplicate classifier runs. The partial unique index on
 * (article_id, job_type) makes the duplicate enqueue impossible rather than merely
 * unlikely, which is why this is an `INSERT OR IGNORE` and a zero-row result is an
 * expected outcome rather than an error.
 *
 * One function for both because the two differ only in their type: the idempotency
 * argument is the same, and a second copy would drift the first time one was edited.
 */
async function enqueueProcessJob(env: Env, articleId: string, type: JobType): Promise<void> {
  const now = Date.now();
  const jobId = newId('job');

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_jobs (id, article_id, job_type, status, attempt_count, deliveries, created_at, updated_at)
     VALUES (?1, ?2, ?4, 'queued', 0, 0, ?3, ?3)`,
  )
    .bind(jobId, articleId, now, type)
    .run();

  if ((inserted.meta.changes ?? 0) === 0) {
    log.info('ingest_deferred', {
      article_id: articleId,
      job_type: type,
      error_message: `A ${type} job is already open for this article.`,
    });
    return;
  }

  await env.ARTICLE_PROCESS_QUEUE.send({
    jobId,
    articleId,
    type,
    attempt: 1,
    createdAt: now,
  });
  log.info('queue_published', { queue: 'article-process', article_id: articleId, job_id: jobId, job_type: type });
}
