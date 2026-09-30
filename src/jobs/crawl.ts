/**
 * SPEC §38 Phase 2 — the crawl job handler.
 *
 * Replaces the Phase 1 placeholder: the `article-ingest` message now performs the
 * actual Browser Run fetch. SPEC §19 requires the consumer to be idempotent, so
 * everything here is keyed on `jobId` and safe to receive twice.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';
import { getArticleById } from '../db/articles';
import { getCrawlJob, recordRetryAttempt, updateJobStatus } from '../db/jobs';
import { crawlArticle } from '../services/crawl';
import { enqueueCrawlJob } from '../services/import';

/**
 * SPEC §25 retry policy.
 *
 * Queues also retry on a thrown error, but that schedule is not ours to control
 * and SPEC §25 specifies its own ladder. The job is therefore re-published at the
 * delay below and acked, rather than relying on `message.retry()`.
 */
export const RETRY_SCHEDULE_MS = [
  60_000, // attempt 2 → +1 min
  300_000, // attempt 3 → +5 min
  1_800_000, // attempt 4 → +30 min
  7_200_000, // attempt 5 → +2 h
  86_400_000, // attempt 6 → +24 h
] as const;

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/** SPEC §36 — a measured account-level 429 twice in one session; back off hard. */
export const RATE_LIMIT_COOLDOWN_MS = 3_600_000;

/** SPEC §25 — retrying is worth it; a login wall or a deleted post is not. */
const RETRYABLE_CODES = new Set(['FETCH_TIMEOUT', 'PAGE_BLOCKED', 'PARSER_FAILED']);

export async function handleCrawl(message: JobMessage, env: Env): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    log.warn('crawl_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      error_code: 'ARTICLE_NOT_FOUND',
      error_message: 'Article row no longer exists; nothing to crawl.',
    });
    await updateJobStatus(env.DB, message.jobId, 'skipped', {
      code: 'ARTICLE_NOT_FOUND',
      message: 'Article row no longer exists',
    });
    return;
  }

  // SPEC §28/§19 — a completed job that gets redelivered must not re-fetch.
  const job = await getCrawlJob(env.DB, message.jobId);
  if (job && (job.status === 'success' || job.status === 'skipped')) {
    log.info('crawl_success', { article_id: message.articleId, job_id: message.jobId, outcome: 'already_done' });
    return;
  }

  const outcome = await crawlArticle(env, {
    articleId: message.articleId,
    url: article.canonical_url,
    fallbackUsername: article.author_username,
    actor: 'queue:crawl',
  });

  if (outcome.ok) {
    await updateJobStatus(env.DB, message.jobId, 'success');
    return;
  }

  const code = outcome.errorCode ?? 'PAGE_BLOCKED';
  const attempt = message.attempt;

  if (!RETRYABLE_CODES.has(code) || attempt >= MAX_ATTEMPTS) {
    await updateJobStatus(env.DB, message.jobId, 'failed', {
      code,
      message: outcome.errorMessage ?? 'Crawl failed',
    });
    log.error('crawl_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      attempt,
      error_code: code,
      error_message: outcome.errorMessage ?? '',
      retryable: RETRYABLE_CODES.has(code),
    });
    return;
  }

  // SPEC §36 — Browser Run rate limits are per account, not per article. The
  // §25 ladder is tuned for a slow target; our own quota needs a much longer
  // pause, and retrying at +1 min just burns the quota faster.
  const delay = outcome.rateLimited
    ? RATE_LIMIT_COOLDOWN_MS
    : RETRY_SCHEDULE_MS[attempt - 1] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1]!;

  await recordRetryAttempt(env.DB, message.jobId, attempt + 1);
  await updateJobStatus(env.DB, message.jobId, 'retrying', {
    code,
    message: outcome.errorMessage ?? 'Crawl failed',
  });

  // SPEC §25 — the ladder. Delivery is delayed rather than immediate so a
  // blocked or slow target is not hammered.
  await env.ARTICLE_INGEST_QUEUE.send(
    { jobId: message.jobId, articleId: message.articleId, type: 'crawl', attempt: attempt + 1, createdAt: Date.now() },
    { delaySeconds: Math.round(delay / 1000) },
  );

  log.warn('crawl_failed', {
    article_id: message.articleId,
    job_id: message.jobId,
    attempt,
    error_code: code,
    error_message: outcome.errorMessage ?? '',
    retry_in_ms: delay,
  });

  void enqueueCrawlJob;
}
