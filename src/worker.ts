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
import { refreshRanking } from './services/ranking-refresh';
import { generateMissingCovers } from './services/cover';
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
   * SPEC §21 — the ranking refresh.
   *
   * `waitUntil` rather than a bare await: the runtime is allowed to end an invocation once
   * the handler's promise settles, and the refresh is a read plus a batched write that must
   * not be cut off halfway. Returning before it finishes is what makes the platform keep
   * the invocation alive for it.
   *
   * A failure is logged and swallowed rather than thrown. Nobody is watching a timer, and
   * an unhandled rejection would surface as a bare cron failure without saying which half
   * ran — the log line carries the counts that matter.
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(generateMissingCovers(env, 1).catch((err: unknown) => {
      log.error('ai_failed', {
        error_code: 'COVER_RETRY_FAILED',
        error_message: err instanceof Error ? err.message : String(err),
      });
    }));
    log.info('ranking_refresh_start', {
      cron: controller.cron,
      environment: env.ENVIRONMENT ?? 'production',
    });
    ctx.waitUntil(
      refreshRanking(env).catch((err: unknown) => {
        log.error('ranking_refresh_failed', {
          error_code: 'RANKING_REFRESH_FAILED',
          error_message: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  },
};
