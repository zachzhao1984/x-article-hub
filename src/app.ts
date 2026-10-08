/** SPEC §31 — Hono app assembly. */

import { Hono } from 'hono';
import type { AdminIdentity } from './middleware/admin-auth';
import { adminApi } from './routes/admin-api';
import { adminUi } from './routes/admin-ui';
import { auth } from './routes/auth';
import { publicApi } from './routes/public-api';
import { errorView } from './routes/views';
import { toAppError } from './lib/errors';
import { log } from './lib/logger';
import { siteConfig } from './config/site';

export type AppEnv = {
  Bindings: Env;
  Variables: { adminIdentity: AdminIdentity };
};

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  const appErr = toAppError(err);
  const level = appErr.status >= 500 ? 'error' : 'warn';
  log[level]('http_error', {
    error_code: appErr.code,
    error_message: appErr.message,
    path: new URL(c.req.url).pathname,
    method: c.req.method,
  });

  if (c.req.path.startsWith('/admin') && c.req.method === 'GET') {
    return c.html(errorView(appErr.status, appErr.code, appErr.message, siteConfig(c.env).name), appErr.status as 500);
  }

  return c.json({ error: { code: appErr.code, message: appErr.message, details: appErr.details } }, appErr.status as 500);
});

/**
 * This sub-app owns `/api/*`, `/admin/*` and `/healthz`. Anything unmatched
 * simply registers no route, so the request continues down the parent's
 * middleware chain and reaches Astro's `pages()` (SPEC §17).
 *
 * There is deliberately no `notFound` handler here: Hono's NotFoundHandler
 * receives no `next`, and the `/api/*` JSON 404 has to be registered on the
 * parent (src/worker.ts) so it runs *before* Astro can answer with an HTML page.
 */

app.route('/api', publicApi);
app.route('/api/admin', adminApi);
app.route('/admin', adminUi);

/**
 * SPEC §43 — reader sign-in.
 *
 * Mounted here rather than as Astro pages because every route is a redirect, and because
 * the callback has to be answered before anything else can: a stale CDN copy of
 * `/account` is harmless, but a `/auth/*` request must never reach the pages fallback. A
 * mis-registered callback URI returning a 404 HTML page as the provider's `redirect_uri`
 * is rejected by both providers with a message that says nothing useful.
 */
app.route('/auth', auth);

app.get('/healthz', (c) => c.text('ok'));
