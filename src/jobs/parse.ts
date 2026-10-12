/**
 * SPEC §38 Phase 3 — the parse job.
 *
 * SPEC §19 requires idempotency: `parseArticle` is a no-op when the parser
 * version and the archive are unchanged, so redelivery is safe.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';
import { getArticleById, setArticleStatus } from '../db/articles';
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

  // SPEC §6 — a parsed article with no editorial state yet belongs in the review queue.
  //
  // The crawl sets the status, but a crawl can fail *after* it has written its capture — a
  // `PAGE_BLOCKED` on a retry, a partial-then-complete fetch — and the article is then left at
  // `failed` while a perfectly good document sits in R2. Nothing else moved it: the parse does
  // not own the status, so the article was invisible to the editor and unreachable by every
  // public query, which read as "the import never worked" for content that was already
  // archived. Measured: 13 of 100 articles were in exactly this state.
  //
  // Only `failed` is promoted. The other terminal states are editorial decisions and must not
  // be overwritten by a machine step — the same reason `nextStatusAfterCrawl` refuses to
  // un-publish. `pending` and `fetching` are not promoted either: they mean a crawl is still
  // in flight, and racing it here would put an article in review before its capture settled.
  //
  // Guarded on `raw_r2_key` so a parse that somehow succeeded with no capture cannot promote
  // an article with nothing to read.
  if (article.status === 'failed' && article.raw_r2_key) {
    await setArticleStatus(env.DB, message.articleId, 'review');
    log.info('publish', {
      article_id: message.articleId,
      actor: 'queue:parse',
      action: 'promoted_to_review',
      // The status it came from, so a log reader can tell this apart from a crawl's own
      // transition to the same value.
      status: 'failed',
    });
  }

  // SPEC §10 — media is derived from the ArticleDocument, so it can only start
  // once the Parser has written one. Enqueuing from here rather than from the
  // crawl keeps the ordering guarantee in one place: there is no path that
  // produces a document without also scheduling the download.
  await enqueueMediaJob(env, message.articleId);

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
 * SPEC §19 — one open media job per article, so a redelivered parse cannot stack
 * duplicate downloads. The partial unique index on (article_id, job_type) makes
 * the duplicate enqueue impossible.
 */
async function enqueueMediaJob(env: Env, articleId: string): Promise<void> {
  const now = Date.now();
  const jobId = newId('job');

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_jobs (id, article_id, job_type, status, attempt_count, deliveries, created_at, updated_at)
     VALUES (?1, ?2, 'media', 'queued', 0, 0, ?3, ?3)`,
  )
    .bind(jobId, articleId, now)
    .run();

  if ((inserted.meta.changes ?? 0) === 0) {
    log.info('ingest_deferred', {
      article_id: articleId,
      job_type: 'media',
      error_message: 'A media job is already open for this article.',
    });
    return;
  }

  await env.ARTICLE_PROCESS_QUEUE.send({
    jobId,
    articleId,
    type: 'media',
    attempt: 1,
    createdAt: now,
  });
  log.info('queue_published', { queue: 'article-process', article_id: articleId, job_id: jobId, job_type: 'media' });
}
