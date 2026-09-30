/**
 * SPEC §31 — Worker entry point.
 *
 * One Worker serves the Hono API, the admin UI, the queue consumers and (later,
 * SPEC §21) the cron triggers. SPEC §29's simplified single-Worker layout.
 */

import { app } from './app';
import { handleBatch } from './jobs/dispatch';
import { log } from './lib/logger';
import type { Env } from './env';
import type { JobMessage } from './jobs/types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await handleBatch(batch, env);
  },

  /**
   * SPEC §21 — Cron Triggers are for metrics / ranking / maintenance / re-index.
   * None of those exist until Phase 4+, so nothing is registered in wrangler.jsonc
   * yet and this handler intentionally does no work.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    log.info('cron_noop', { cron: controller.cron, environment: env.ENVIRONMENT ?? 'production' });
    ctx.waitUntil(Promise.resolve());
  },
};
