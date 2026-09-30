/** SPEC §31 — Hono app assembly. */

import { Hono } from 'hono';
import type { Env } from './env';
import type { AdminIdentity } from './middleware/admin-auth';
import { adminApi } from './routes/admin-api';
import { adminUi } from './routes/admin-ui';
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

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404);
  }
  // SPEC §33 — the public site is Phase 5; until then the asset worker owns `/`.
  if (c.req.method === 'GET') return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
});

app.route('/api', publicApi);
app.route('/api/admin', adminApi);
app.route('/admin', adminUi);

app.get('/healthz', (c) => c.text('ok'));
