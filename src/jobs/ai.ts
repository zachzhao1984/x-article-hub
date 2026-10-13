/**
 * SPEC §13 / §19 — the `ai` job, which until now was a declared type with no consumer.
 *
 * Idempotent the same way `handleParse` is: the work is keyed by the `crawl_jobs` row,
 * a completed job short-circuits, and the partial unique index on
 * (article_id, job_type) means a redelivered parse cannot stack a second classifier
 * run for the same article.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';
import { getArticleById } from '../db/articles';
import { getCrawlJob, updateJobStatus } from '../db/jobs';
import { classifyArticle } from '../services/classify';

export async function handleAi(message: JobMessage, env: Env): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    await updateJobStatus(env.DB, message.jobId, 'skipped', {
      code: 'NOT_FOUND',
      message: 'Article row no longer exists',
    });
    log.warn('ai_failed', { article_id: message.articleId, job_id: message.jobId, error_code: 'NOT_FOUND' });
    return;
  }

  const job = await getCrawlJob(env.DB, message.jobId);
  if (job && (job.status === 'success' || job.status === 'skipped')) {
    log.info('ai_success', { article_id: message.articleId, job_id: message.jobId, status: 'already_done' });
    return;
  }

  const outcome = await classifyArticle(env, message.articleId);

  if (!outcome.ok) {
    // None of these are worth a retry, so they are all terminal. `NOT_FOUND` is
    // `skipped` rather than `failed` to match `handleParse`: the article being gone is
    // an expected outcome of a delete, not a fault in the classifier.
    const status = outcome.errorCode === 'NOT_FOUND' ? 'skipped' : 'failed';
    await updateJobStatus(env.DB, message.jobId, status, {
      code: outcome.errorCode ?? 'CLASSIFY_FAILED',
      message: outcome.errorMessage ?? '',
    });
    log.error('ai_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      attempt: message.attempt,
      error_code: outcome.errorCode ?? 'CLASSIFY_FAILED',
      error_message: outcome.errorMessage ?? '',
    });
    return;
  }

  await updateJobStatus(env.DB, message.jobId, 'success');

  log.info('ai_success', {
    article_id: message.articleId,
    job_id: message.jobId,
    model: 'classify',
    outcome: outcome.result,
    category_slug: outcome.categorySlug ?? null,
  });
}
