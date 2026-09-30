/**
 * SPEC §38 Phase 3 — the parse job.
 *
 * SPEC §19 requires idempotency: `parseArticle` is a no-op when the parser
 * version and the archive are unchanged, so redelivery is safe.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';
import { getArticleById } from '../db/articles';
import { getCrawlJob, updateJobStatus } from '../db/jobs';
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

  log.info('parse_success', {
    article_id: message.articleId,
    job_id: message.jobId,
    parser_version: PARSER_VERSION,
    outcome: outcome.result,
    block_count: outcome.blockCount,
    word_count: outcome.wordCount,
  });
}
