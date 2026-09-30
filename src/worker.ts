/**
 * SPEC §31 — Worker entry point.
 *
 * One Worker serves everything:
 *
 *   /api/*   public + admin JSON API   (Hono, src/routes/*)
 *   /admin*  admin UI                  (Hono, src/routes/admin-ui.ts)
 *   /*       public reading site       (Astro, src/pages/*)
 *   queue    ingest / process consumers
 *   cron     ranking + metrics (SPEC §21)
 *
 * The Astro Cloudflare adapter ships a first-class Hono pipeline, so the existing
 * Hono routes slot in between `middleware()` and `pages()` instead of being
 * reimplemented — see https://docs.astro.build/en/guides/integrations-guide/cloudflare/
 */

import { Hono, type Context } from 'hono';
import { actions, i18n, middleware, pages } from 'astro/hono';
import { cf } from '@astrojs/cloudflare/hono';

import { app as apiApp } from './app';
import { handleBatch } from './jobs/dispatch';
import { log } from './lib/logger';
import type { JobMessage } from './jobs/types';

const worker = new Hono<{ Bindings: Env }>();

// cf() must come first: it provides env + executionCtx and serves static assets.
worker.use(cf());
worker.use(actions());
// Astro middleware (src/middleware.ts) runs before anything renders.
worker.use(middleware());

// The existing Phase 1 API + admin surface, unchanged.
worker.route('/', apiApp);

// An unmatched /api/* path must not fall through to Astro, which would hand an
// HTML 404 page to a JSON client. A sub-app's notFound does not apply to the
// parent, so the guard has to sit here, ahead of pages().
const apiNotFound = (c: Context) =>
  c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404);
worker.all('/api', apiNotFound);
worker.all('/api/*', apiNotFound);

// Everything unmatched falls through to Astro pages.
worker.use(pages());
worker.use(i18n());

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await handleBatch(batch, env);
  },

  /**
   * SPEC §21 — Cron Triggers are for metrics / ranking / maintenance / re-index.
   * None of those exist until Phase 6, so nothing is registered in wrangler.jsonc
   * yet and this handler intentionally does no work.
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    log.info('cron_noop', { cron: controller.cron, environment: env.ENVIRONMENT ?? 'production' });
    ctx.waitUntil(Promise.resolve());
  },
};
