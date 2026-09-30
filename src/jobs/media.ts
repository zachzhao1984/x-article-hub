/**
 * SPEC §38 Phase 3 (media) — the media job.
 *
 * SPEC §19 requires idempotency: `downloadArticleMedia` skips any image that
 * already has an r2_key, so a redelivered message re-attempts only what actually
 * failed and a completed article costs nothing.
 *
 * The job never fails the article. SPEC §10 is explicit that a bad image must not
 * fail its Article, so a run where some images fail is recorded as a success with
 * a partial result; the per-image state lives in `media_objects` and is visible in
 * the admin surface.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';
import { getArticleById } from '../db/articles';
import { getCrawlJob, updateJobStatus } from '../db/jobs';
import { downloadArticleMedia } from '../services/media';

export async function handleMedia(message: JobMessage, env: Env): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    await updateJobStatus(env.DB, message.jobId, 'skipped', {
      code: 'NOT_FOUND',
      message: 'Article row no longer exists',
    });
    log.warn('media_failed', { article_id: message.articleId, error_code: 'NOT_FOUND' });
    return;
  }

  const job = await getCrawlJob(env.DB, message.jobId);
  if (job && (job.status === 'success' || job.status === 'skipped')) {
    log.info('media_success', { article_id: message.articleId, job_id: message.jobId, status: 'already_done' });
    return;
  }

  if (!article.content_r2_key) {
    // The Parser has not run yet. That is an ordering problem, not a failure, so
    // the job is retried rather than failed — a media message can legitimately
    // arrive before the parse message is delivered.
    await updateJobStatus(env.DB, message.jobId, 'retrying', {
      code: 'RAW_MISSING',
      message: 'The Parser has not produced a document yet; nothing to download media for.',
    });
    log.warn('media_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      error_code: 'RAW_MISSING',
    });
    return;
  }

  const outcome = await downloadArticleMedia(env, message.articleId);

  if (!outcome.ok && outcome.ready === 0) {
    // Nothing at all could be fetched. The images may simply be gone from X, in
    // which case retrying forever is pointless, but the article itself is still
    // publishable with external_fallback images. So this is a partial success:
    // the job is done, the state is in media_objects, and the admin can retry.
    await updateJobStatus(env.DB, message.jobId, 'success', {
      code: 'MEDIA_PARTIAL',
      message: `${outcome.failures.length} image(s) could not be archived; the article falls back to X's CDN.`,
    });
    log.warn('media_failed', {
      article_id: message.articleId,
      job_id: message.jobId,
      error_code: 'MEDIA_PARTIAL',
      failures: outcome.failures.length,
    });
    return;
  }

  await updateJobStatus(env.DB, message.jobId, 'success');

  log.info('media_success', {
    article_id: message.articleId,
    job_id: message.jobId,
    ready: outcome.ready,
    failed: outcome.failed,
    skipped: outcome.skipped,
  });
}
