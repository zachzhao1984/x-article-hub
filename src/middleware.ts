// SPEC §23 — cache policy. Homepage 60s, category 300s, article 3600s, admin no-store.
import { defineMiddleware } from 'astro:middleware';

const TTL_SECONDS: Array<[RegExp, number]> = [
  [/^\/$/, 60],
  [/^\/(latest|trending|rising|about)$/, 60],
  [/^\/category\//, 300],
  [/^\/tag\//, 300],
  [/^\/author\//, 300],
  [/^\/article\//, 3600],
  [/^\/(sitemap\.xml|feed\.xml|robots\.txt)$/, 3600],
  [/^\/search/, 30],
];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // SPEC §23 — admin is never cached.
  if (path.startsWith('/admin')) {
    const response = await next();
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const response = await next();

  // SPEC §23 — public API endpoints carry their own TTLs (set by the route),
  // admin API must never be cached.
  if (path === '/api' || path.startsWith('/api/admin')) {
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  // A 404 should stay a 404 rather than being cached into the edge.
  if (response.status === 404) return response;

  // SPEC §23 — cache key includes pathname and query string; s-maxage lets the
  // CDN serve it while the browser revalidates.
  const ttl = TTL_SECONDS.find(([pattern]) => pattern.test(path))?.[1];
  if (ttl && !response.headers.has('Cache-Control')) {
    response.headers.set('Cache-Control', `public, max-age=${Math.min(ttl, 60)}, s-maxage=${ttl}`);
  }

  return response;
});
