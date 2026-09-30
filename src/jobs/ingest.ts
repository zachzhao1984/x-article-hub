/**
 * SPEC §38 Phase 1 — the crawl job is accepted and recorded, but not executed.
 *
 * What Phase 1 proves (SPEC §38 acceptance for Phase 1):
 *   - a pasted URL produces a `crawl_jobs` row
 *   - the message is delivered by the `article-ingest` queue
 *   - the delivery is visible in D1 (`deliveries`, `last_delivered_at`)
 *
 * What Phase 2 adds: `env.BROWSER.quickAction('markdown' | 'content')` per SPEC §7,
 * writing `articles/{id}/raw/page.html` + `page.md` to R2 (SPEC §8). The job is
 * deliberately left in `queued` rather than marked `success`, so the admin UI
 * shows the honest state and SPEC §16.4's Retry still applies.
 */

import type { JobMessage } from './types';
import { log } from '../lib/logger';

export async function handleIngest(message: JobMessage, env: Env): Promise<void> {
  const job = await env.DB.prepare(`SELECT status FROM crawl_jobs WHERE id = ?1`).bind(message.jobId).first<{
    status: string;
  }>();

  if (!job) {
    log.warn('ingest_deferred', { job_id: message.jobId, article_id: message.articleId, error_code: 'JOB_NOT_FOUND' });
    return;
  }

  log.info('ingest_deferred', {
    job_id: message.jobId,
    article_id: message.articleId,
    job_type: message.type,
    attempt: message.attempt,
    status: job.status,
    error_code: 'CRAWL_NOT_IMPLEMENTED',
    error_message: 'Phase 2 (Browser Run crawl) is not implemented yet; job stays queued for admin retry.',
  });
}
