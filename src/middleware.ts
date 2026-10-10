// SPEC §23 — cache policy. Homepage 60s, category 300s, article 3600s, admin no-store.
//
// The list pages that read only published, un-taken-down articles. `/featured` and
// `/authors` were both missing from this table at some point — `/featured` for as long as
// it has existed — so neither had any `s-maxage` at all and every visit reached the
// Worker. Neither reads the session, so both are safe to share.
//
// The predicate is "does this page differ per reader": these do not, so they are here.
// `/account` and `/auth/*` do, and are handled separately below.
import { defineMiddleware } from 'astro:middleware';

const TTL_SECONDS: Array<[RegExp, number]> = [
  [/^\/$/, 60],
  [/^\/(latest|trending|featured|authors|about)$/, 60],
  [/^\/category\//, 300],
  [/^\/tag\//, 300],
  [/^\/author\//, 300],
  [/^\/article\//, 3600],
  [/^\/(sitemap\.xml|feed\.xml|robots\.txt)$/, 3600],
  [/^\/search/, 30],
];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // SPEC §23 — admin is never cached. SPEC §43 — nor are the reader's account page or
  // the sign-in endpoints.
  //
  // `/account` differs per reader by definition: it renders the reader's name, their
  // address and their connected providers. Caching it would serve one person's account
  // page to whoever asked next, which is not a performance win, it is a disclosure.
  // `/auth/*` is here for a different reason — it is almost entirely redirects that mint
  // a cookie, and a cached 302 would replay a past visitor's session into a later one.
  //
  // Note what is deliberately *not* on this list: every other page stays publicly
  // cacheable, and none of them read the session cookie. That is what makes the header's
  // account slot safe — see the note in SiteHeader.astro.
  //
  // `/saved` is a reader's private list, so it belongs here for the same reason `/account`
  // does — not "it happens to differ" but "caching it would show one reader another's".
  //
  // `/auth` is matched as a path *segment* and not by prefix. A prefix test for `/auth`
  // also matches `/authors`, which is a public list page that reads nothing per reader and
  // has no business being uncacheable — and it did not announce itself: the page rendered
  // correctly and was simply never cached, which is a performance regression that looks
  // like nothing at all. `/auth` and `/auth/…` are the two shapes the routes actually take.
  //
  // (The buggy form is not written out here on purpose. Spelling it makes the assertion in
  // tests/unit/authors-page.test.ts match this comment rather than the code it is about —
  // which has already happened four times in this repository.)
  if (
    path.startsWith('/admin') ||
    path.startsWith('/account') ||
    path.startsWith('/saved') ||
    path === '/auth' ||
    path.startsWith('/auth/')
  ) {
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
