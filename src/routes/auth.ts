/**
 * SPEC §43 — the OAuth endpoints, mounted at `/auth`.
 *
 * Mounted in front of Astro (see src/app.ts) because every route here is a redirect
 * rather than a rendered page: the only HTML in this flow is `/account`, which is an
 * ordinary Astro page like the rest of the site.
 *
 * ## Why `state` lives in D1 rather than in a cookie
 *
 * The usual design pairs a `state` parameter with a cookie holding the same value and
 * compares the two on the way back. That needs a *signed* cookie, which means the
 * `state` is readable and forgeable by anyone holding the signing secret, so CSRF
 * protection would rest entirely on that secret staying unguessable. Storing it
 * server-side instead means the only thing that can advance a flow is a row this Worker
 * wrote, and that row is spent exactly once (`takeOAuthState`). The cost is a read and
 * a write per sign-in. The benefit is that CSRF protection and PKCE do not depend on a
 * secret remaining secret.
 *
 * ## Failures redirect rather than render
 *
 * Every error becomes a redirect to `/account?error=<code>`. A provider refusing a
 * sign-in is not a server error, and a JSON body reading `OAUTH_INVALID_STATE` is not
 * something a reader who just pressed "Continue with X" can act on. The code travels in
 * the query string so `/account` can say something specific; the provider's own response
 * text stays in the logs, because a URL is captured in browser history and leaks into
 * referrers to third parties.
 */

import { Hono } from 'hono';
import {
  buildAuthorizeUrl,
  exchangeCode,
  pkceChallenge,
  providerSpec,
  randomToken,
  requireProviderConfig,
  safeRedirectPath,
  type ProviderId,
} from '../lib/oauth';
import {
  clearUserCookie,
  createSession,
  hashSessionToken,
  OAUTH_STATE_TTL_MS,
  readUserCookie,
  resolveSession,
  setUserCookie,
  signOut,
  toPublicUser,
} from '../lib/user-session';
import {
  insertOAuthState,
  isSaved,
  saveArticle,
  takeOAuthState,
  unsaveArticle,
} from '../db/users';
import { resolveLogin } from '../services/login';
import { toAppError } from '../lib/errors';
import { log } from '../lib/logger';
import { siteConfig } from '../config/site';

interface AuthEnv {
  Bindings: Env;
}

export const auth = new Hono<AuthEnv>();

/**
 * `Secure` comes from the deployment's own configured origin, never from a forwarded
 * header — a header that decides whether a cookie gets the `Secure` attribute is a
 * header that can decide not to set it.
 */
function isSecure(env: Env): boolean {
  return siteConfig(env).origin.startsWith('https://');
}

/**
 * Cloudflare sets `cf-connecting-ip` on every request and clients cannot forge it.
 * `x-forwarded-for` would be the wrong header to reach for here.
 */
function addressOf(c: { req: { header(name: string): string | undefined } }): string | null {
  return c.req.header('cf-connecting-ip') ?? null;
}

/** Redirect back into the site carrying a machine-readable reason. */
function withError(env: Env, redirectTo: string, code: string): Response {
  const url = new URL(safeRedirectPath(redirectTo), siteConfig(env).origin);
  url.searchParams.set('error', code);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  });
}

function redirect(status: 302 | 303, location: string, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status, headers });
}

/**
 * Step 1 — send the reader to the provider.
 *
 * The PKCE verifier is generated here and stays server-side; only its SHA-256 challenge
 * travels.
 *
 * Nothing about the caller's current session is read or recorded. With two providers this
 * is where `link_to_user_id` was captured, so a flow begun while signed in could attach
 * the second provider to that account. With one provider that branch became a way to merge
 * two Google accounts without the second owner's agreement — see `resolveLogin` — so the
 * column is gone, and this route no longer touches the session at all. That is one fewer
 * D1 read on the way into every sign-in.
 */
auth.get('/:provider/start', async (c) => {
  const spec = providerSpec(c.req.param('provider'));
  const next = safeRedirectPath(c.req.query('next'));

  if (!spec) return withError(c.env, next, 'unknown-provider');

  let config;
  try {
    config = requireProviderConfig(c.env, spec.id);
  } catch {
    // The normal state until an app is registered. Say so rather than erroring.
    return withError(c.env, next, 'not-configured');
  }

  const now = Date.now();
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);

  await insertOAuthState(c.env.DB, {
    state,
    provider: config.id as ProviderId,
    codeVerifier: verifier,
    redirectTo: next,
    now,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  }).run();

  log.info('oauth_start', { provider: config.id });

  return redirect(302, buildAuthorizeUrl(config, { state, challenge }));
});

/**
 * Step 2 — redeem the code, resolve the account, open the session.
 *
 * Each rejection returns to the `redirect_to` the flow was started with, so a sign-in
 * begun from deep in the site comes back there instead of dumping the reader on the
 * account page with no context.
 */
auth.get('/:provider/callback', async (c) => {
  const id = c.req.param('provider');
  const url = new URL(c.req.url);

  // The provider reports its own failure this way: the reader pressed Cancel, or
  // consent was refused. Not our error, so not logged as one — but it still deserves to
  // say what happened rather than showing nothing at all.
  const providerError = url.searchParams.get('error');
  if (providerError) {
    log.info('oauth_declined', { provider: id, reason: providerError });
    return withError(c.env, '/account', providerError === 'access_denied' ? 'cancelled' : 'declined');
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) {
    log.warn('oauth_callback_incomplete', {
      provider: id,
      has_state: state !== null,
      has_code: code !== null,
    });
    return withError(c.env, '/account', 'incomplete');
  }

  let spec;
  try {
    spec = requireProviderConfig(c.env, id);
  } catch {
    return withError(c.env, '/account', 'not-configured');
  }

  const now = Date.now();
  // Single-use: this both validates the `state` and destroys it.
  const stored = await takeOAuthState(c.env.DB, state, now);
  if (!stored || stored.provider !== spec.id) {
    // No row at all means this Worker never issued that `state`. A row naming a
    // different provider means it was issued for someone else's flow — worth a log line
    // either way, because the second is also what two open tabs look like from here.
    log.warn('oauth_state_rejected', {
      provider: id,
      found: stored !== null,
      state_provider: stored?.provider ?? null,
    });
    return withError(c.env, '/account', 'state');
  }

  try {
    const accessToken = await exchangeCode(spec, { code, verifier: stored.code_verifier });
    const profile = await spec.readProfile(accessToken);

    const { user, outcome } = await resolveLogin(c.env.DB, {
      provider: spec.id,
      profile,
      now,
    });

    const { token, expiresAt } = await createSession({
      db: c.env.DB,
      userId: user.id,
      now,
      userAgent: c.req.header('user-agent'),
      address: addressOf(c),
      pepper: c.env.USER_SESSION_SECRET,
    });

    log.info('oauth_login', { user_id: user.id, provider: spec.id, outcome });

    const headers = new Headers();
    setUserCookie(headers, token, expiresAt, isSecure(c.env));
    // 303 rather than 302: the reader arrived by GET, and a 303 makes the browser
    // re-issue as GET so the callback URL cannot be replayed by hitting Back.
    return redirect(303, safeRedirectPath(stored.redirect_to), headers);
  } catch (err) {
    const appErr = toAppError(err);
    log.warn('oauth_callback_failed', {
      provider: spec.id,
      error_code: appErr.code,
      error_message: appErr.message,
    });
    return withError(c.env, stored.redirect_to, appErr.code.toLowerCase());
  }
});

/**
 * Sign out.
 *
 * `POST` and not `GET`, because a GET that changes state is what lets a prefetch or a
 * crawler's link preview sign somebody out. There is no CSRF token here and the worst a
 * cross-site POST achieves is a sign-out, but a bare link would make that reachable from
 * any page at all.
 */
auth.post('/logout', async (c) => {
  const token = readUserCookie(c.req.header('cookie'));
  if (token) {
    await signOut(c.env.DB, await hashSessionToken(token));
  }
  const headers = new Headers();
  clearUserCookie(headers, isSecure(c.env));
  return redirect(303, '/', headers);
});

/**
 * SPEC §43 — save / unsave, for the reading page's button.
 *
 * `POST` for both, because both change state. The two verbs are separate endpoints rather
 * than one toggle: a toggle has to decide what to do from the request, and a request that
 * says "flip it" is a request whose outcome depends on state the client read earlier. Two
 * explicit endpoints make a double-submit idempotent — saving twice leaves one row rather
 * than un-saving what the first request saved.
 *
 * `fetch` rather than a form, because the button must not navigate: the reader is mid
 * article, and a form POST would either reload the page or lose their scroll position. The
 * response carries the new state so the button can settle on what the server actually
 * recorded rather than on what it hoped.
 *
 * 401 when signed out, unlike `/auth/me` which answers `{ user: null }`. The difference is
 * that this is an action: there is no state to report, and the caller has to do something
 * different (send the reader to sign in) rather than render one of two shapes.
 */
auth.post('/saved/:articleId', async (c) => {
  const session = await resolveSession(c.env.DB, c.req.header('cookie'), Date.now());
  if (!session) return c.json({ error: 'UNAUTHORIZED', saved: false }, 401, { 'Cache-Control': 'no-store' });

  const articleId = c.req.param('articleId');
  // The article has to exist and be readable, or a reader could save a private string and
  // the list would have a row that no query joins to.
  const article = await c.env.DB.prepare(
    `SELECT id FROM articles WHERE id = ?1 AND status = 'published' AND display_mode != 'takedown'`,
  )
    .bind(articleId)
    .first<{ id: string }>();
  if (!article) return c.json({ error: 'NOT_FOUND', saved: false }, 404, { 'Cache-Control': 'no-store' });

  await saveArticle(c.env.DB, session.user.id, articleId, Date.now()).run();
  return c.json({ saved: true }, 200, { 'Cache-Control': 'no-store' });
});

auth.delete('/saved/:articleId', async (c) => {
  const session = await resolveSession(c.env.DB, c.req.header('cookie'), Date.now());
  if (!session) return c.json({ error: 'UNAUTHORIZED', saved: false }, 401, { 'Cache-Control': 'no-store' });

  // No existence check: removing a row that is not there reaches the same state, and a 404
  // would make the client treat an already-unsaved article as a failure.
  await unsaveArticle(c.env.DB, session.user.id, c.req.param('articleId')).run();
  return c.json({ saved: false }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * Whether this reader has saved this article, for the button's initial state.
 *
 * Its own endpoint rather than part of `/auth/me`, because the answer depends on which
 * article is being read — `/auth/me` is cached by nothing and shared by every page, and
 * hanging a per-article field off it would make it per-article too.
 */
auth.get('/saved/:articleId', async (c) => {
  const session = await resolveSession(c.env.DB, c.req.header('cookie'), Date.now());
  if (!session) return c.json({ saved: false, authenticated: false }, 200, { 'Cache-Control': 'no-store' });
  const row = await isSaved(c.env.DB, session.user.id, c.req.param('articleId'));
  return c.json({ saved: row !== null, authenticated: true }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * Who am I, for the header.
 *
 * `no-store`, because this is the one response that differs per reader — and it is what
 * lets the header's account slot be filled in without any cached HTML becoming
 * reader-specific (see the note on the slot in SiteHeader.astro). Returns
 * `{ user: null }` rather than 401 when signed out: being signed out is a normal state
 * the caller handles, not a request that failed.
 */
auth.get('/me', async (c) => {
  const session = await resolveSession(c.env.DB, c.req.header('cookie'), Date.now());
  return c.json(
    { user: session ? toPublicUser(session.user) : null },
    200,
    { 'Cache-Control': 'no-store' },
  );
});