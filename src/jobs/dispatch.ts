/**
 * SPEC §19 — queue consumer dispatch.
 *
 * SPEC §19: "消费者必须幂等" (consumers must be idempotent). Everything below is
 * safe to receive twice: state lives in D1, keyed by `jobId`.
 */

import { isJobMessage, type JobMessage } from './types';
import { recordDelivery } from '../db/jobs';
import { log } from '../lib/logger';
import { handleCrawl } from './crawl';
import { handleParse } from './parse';
import { handleMedia } from './media';
import { handleAi } from './ai';

type Handler = (message: JobMessage, env: Env) => Promise<void>;

const handlers: Record<JobMessage['type'], Handler> = {
  // SPEC §38 Phase 2 — the real Browser Run crawl.
  crawl: handleCrawl,
  // SPEC §38 Phase 3 — raw → ArticleDocument → D1.
  parse: handleParse,
  // SPEC §10 — source image URL → R2, so the archive stops depending on X's CDN.
  media: handleMedia,
  // SPEC §13 — the editor assistant. Only categorisation is implemented; summary,
  // topics, tags and quality still have no consumer and stay deferred below.
  ai: handleAi,
  // Phase 4 / 6 own these. Declared so an unroutable message is caught here
  // instead of being silently acked somewhere else.
  metrics: notImplemented('metrics'),
  reindex: notImplemented('reindex'),
};

function notImplemented(type: string): Handler {
  return async (message) => {
    log.warn('ingest_deferred', {
      job_id: message.jobId,
      article_id: message.articleId,
      job_type: type,
      error_message: `No consumer registered for job type "${type}" yet`,
    });
  };
}

export async function handleBatch(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleMessage(message.body, env);
      message.ack();
    } catch (err) {
      // Re-throwing lets the queue apply its own retry policy on top of the
      // SPEC §25 ladder the crawl job manages itself (SPEC §25).
      log.error('ingest_invalid', {
        job_id: message.body && typeof message.body === 'object' ? (message.body as JobMessage).jobId : undefined,
        error_code: 'CONSUMER_THREW',
        error_message: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}

export async function handleMessage(body: unknown, env: Env): Promise<void> {
  if (!isJobMessage(body)) {
    log.warn('ingest_invalid', { error_code: 'MALFORMED_MESSAGE', error_message: 'Message body is not a JobMessage' });
    return;
  }

  const handler = handlers[body.type];
  if (!handler) {
    log.warn('ingest_invalid', { job_id: body.jobId, error_code: 'UNKNOWN_JOB_TYPE', job_type: body.type });
    return;
  }

  const startedAt = Date.now();
  const job = await recordDelivery(env.DB, body.jobId, body.attempt);
  if (!job) {
    // The article or job row was deleted between produce and consume. SPEC §19
    // requires idempotency, so this is expected, not an error.
    log.warn('ingest_invalid', {
      job_id: body.jobId,
      article_id: body.articleId,
      job_type: body.type,
      error_code: 'JOB_NOT_FOUND',
    });
    return;
  }

  if (job.status === 'success' || job.status === 'skipped') {
    log.info('ingest_received', {
      job_id: body.jobId,
      article_id: body.articleId,
      job_type: body.type,
      status: 'already_done',
    });
    return;
  }

  log.info('ingest_received', {
    job_id: body.jobId,
    article_id: body.articleId,
    job_type: body.type,
    attempt: body.attempt,
    started_at: startedAt,
  });

  await handler(body, env);

  log.info('ingest_received', {
    job_id: body.jobId,
    article_id: body.articleId,
    job_type: body.type,
    completed_at: Date.now(),
    duration_ms: Date.now() - startedAt,
  });
}
