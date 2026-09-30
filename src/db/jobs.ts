/** SPEC §11.8 — crawl job persistence and queue observability. */

import type { CrawlJobRow } from './rows';
import { newId } from '../lib/ids';
import type { JobMessage, JobStatus, JobType } from '../jobs/types';

export async function createCrawlJob(db: D1Database, articleId: string, jobType: JobType): Promise<CrawlJobRow> {
  const now = Date.now();
  const id = newId('job');
  await db
    .prepare(
      `INSERT INTO crawl_jobs (id, article_id, job_type, status, attempt_count, deliveries, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'queued', 0, 0, ?4, ?5)`,
    )
    .bind(id, articleId, jobType, now, now)
    .run();

  return getCrawlJob(db, id) as Promise<CrawlJobRow>;
}

export function getCrawlJob(db: D1Database, jobId: string): Promise<CrawlJobRow | null> {
  return db
    .prepare(`SELECT * FROM crawl_jobs WHERE id = ?1`)
    .bind(jobId)
    .first<CrawlJobRow>();
}

export function listCrawlJobsForArticle(db: D1Database, articleId: string, limit = 20): Promise<CrawlJobRow[]> {
  return db
    .prepare(`SELECT * FROM crawl_jobs WHERE article_id = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(articleId, limit)
    .all<CrawlJobRow>()
    .then((r) => r.results);
}

export async function listFailedJobs(db: D1Database, limit = 50): Promise<CrawlJobRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM crawl_jobs WHERE status IN ('failed', 'failure') ORDER BY updated_at DESC LIMIT ?1`)
    .bind(limit)
    .all<CrawlJobRow>();
  return results;
}

/**
 * SPEC §19 — the queue consumer increments `deliveries` so we can tell the
 * difference between "message was never produced" and "message was produced but
 * the consumer did nothing", which is exactly the Phase 1 → Phase 2 boundary.
 */
export async function recordDelivery(db: D1Database, jobId: string, attempt: number): Promise<CrawlJobRow | null> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE crawl_jobs
          SET deliveries = deliveries + 1,
              last_delivered_at = ?2,
              attempt_count = MAX(attempt_count, ?3),
              status = CASE WHEN status IN ('pending', 'queued', 'retrying') THEN 'running' ELSE status END,
              started_at = COALESCE(started_at, ?2),
              updated_at = ?2
        WHERE id = ?1`,
    )
    .bind(jobId, now, attempt)
    .run();
  return getCrawlJob(db, jobId);
}

export async function updateJobStatus(
  db: D1Database,
  jobId: string,
  status: JobStatus,
  error?: { code: string; message: string },
): Promise<void> {
  const now = Date.now();
  const terminal = status === 'success' || status === 'failed' || status === 'skipped';
  await db
    .prepare(
      `UPDATE crawl_jobs
          SET status = ?2,
              error_code = COALESCE(?3, error_code),
              error_message = COALESCE(?4, error_message),
              completed_at = CASE WHEN ?5 THEN ?6 ELSE completed_at END,
              updated_at = ?6
        WHERE id = ?1`,
    )
    .bind(jobId, status, error?.code ?? null, error?.message ?? null, terminal ? 1 : 0, now)
    .run();
}

export function toJobMessage(job: CrawlJobRow, attempt = 1): JobMessage {
  return {
    jobId: job.id,
    articleId: job.article_id,
    type: job.job_type,
    attempt,
    createdAt: Date.now(),
  };
}

/**
 * SPEC §25 — an admin retry is attempt N+1. Persisting the counter here (rather
 * than only in the consumer) is what makes a retry visible in the admin UI
 * immediately, before the queue has delivered the message back.
 */
export async function recordRetryAttempt(db: D1Database, jobId: string, attempt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE crawl_jobs
          SET attempt_count = ?2,
              status = 'queued',
              error_code = NULL,
              error_message = NULL,
              completed_at = NULL,
              updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(jobId, attempt, Date.now())
    .run();
}
