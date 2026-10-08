/**
 * SPEC §24 — admin security.
 *
 * "不要自己实现完整管理员认证" (do not implement full admin auth yourself).
 * Production puts admin behind Cloudflare Access, which authenticates the
 * request before it ever reaches this Worker. All this middleware does is:
 *
 *   1. trust the identity header Cloudflare Access injects
 *      (`Cf-Access-Authenticated-User-Email`), and
 *   2. accept a shared `ADMIN_TOKEN` for local development and `curl`.
 *
 * The browser path is a thin session shim over that same shared secret: a
 * successful token login sets a cookie holding an HMAC of `ADMIN_TOKEN`, so the
 * cookie can be verified but cannot be forged without knowing the secret.
 * There is no user table, no password store and no long-lived session state.
 */

import type { Context } from 'hono';
import { log } from '../lib/logger';
import { resolveSession } from '../lib/user-session';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const COOKIE_NAME = 'xah_admin';

/** Fixed label so the signature can never collide with a hash of something else. */
const SESSION_LABEL = 'xah-admin-session-v1';

export interface AdminIdentity {
  actor: string;
  via: 'cloudflare-access' | 'admin-token' | 'session-cookie' | 'user-account';
}

export function resolveIdentity(c: Context): AdminIdentity | null {
  const accessEmail = c.req.header(ACCESS_EMAIL_HEADER)?.trim();
  if (accessEmail) {
    return { actor: accessEmail, via: 'cloudflare-access' };
  }

  // Belt and braces: if Access asserted a JWT we know it ran, even without an email.
  if (c.req.header(ACCESS_JWT_HEADER)) {
    return { actor: 'access-user', via: 'cloudflare-access' };
  }

  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return null;

  // SPEC §24 dev shim. Header first (curl, scripts), then the browser cookie.
  const headerToken = c.req.header('authorization')?.replace(/^Bearer /i, '').trim() ?? c.req.header('x-admin-token')?.trim();
  if (headerToken && timingSafeEqual(headerToken, expected)) {
    return { actor: 'admin-token', via: 'admin-token' };
  }

  return null;
}

/**
 * Async because the cookie check is an HMAC, not a string compare. Split out so
 * the login route can mint the same value.
 */
export async function verifySessionCookie(c: Context, secret: string): Promise<boolean> {
  const cookie = readCookie(c, COOKIE_NAME);
  if (!cookie) return false;
  return timingSafeEqual(cookie, await signSession(secret));
}

/**
 * SPEC §43 — admin by real account, as an alternative to the shared token.
 *
 * Additive, and checked *after* the token rather than instead of it. The token is the
 * path that cannot be taken away by anything that happens at an OAuth provider — an X
 * outage, a revoked X app, a Google consent screen somebody disabled — so it stays the
 * way in when the alternative is not working, and it stays the way out if this branch is
 * ever wrong.
 *
 * The role comes from the `users` row, not from the cookie. A cookie carrying the role
 * would hand admin to anyone willing to edit one value in their own browser; here,
 * changing the role in D1 takes effect on the very next request.
 *
 * A signed-in account *without* the role is not an identity, and saying so is the point:
 * the likeliest reason somebody with a working account is hitting a 401 here is that
 * nobody has run `GRANT_ADMIN_SQL` for their address yet, and a log line naming them
 * turns that from a mystery into a one-line fix.
 */
async function resolveAccountIdentity(c: Context): Promise<AdminIdentity | null> {
  const session = await resolveSession(c.env.DB, c.req.header('cookie'), Date.now());
  if (!session) return null;

  if (session.user.role !== 'admin') {
    log.info('admin_denied_role', {
      user_id: session.user.id,
      actor: session.user.email ?? '(no email)',
      role: session.user.role,
      path: new URL(c.req.url).pathname,
    });
    return null;
  }

  return {
    // The address where there is one, so an event log entry names a person rather than
    // an id. An X-only account has none; its id is still on the `users` row.
    actor: session.user.email ?? session.user.id,
    via: 'user-account',
  };
}

export function requireAdmin() {
  return async (c: Context, next: () => Promise<void>) => {
    let identity = resolveIdentity(c);

    if (!identity && c.env.ADMIN_TOKEN && (await verifySessionCookie(c, c.env.ADMIN_TOKEN))) {
      identity = { actor: 'admin-token', via: 'session-cookie' };
    }

    if (!identity) {
      identity = await resolveAccountIdentity(c);
    }

    if (!identity) {
      const path = new URL(c.req.url).pathname;
      log.warn('admin_unauthorized', { path, method: c.req.method });

      // A browser hitting an admin *page* should land on the login form, not on raw JSON.
      // API and non-GET callers still get JSON.
      if (!path.startsWith('/api/') && c.req.method === 'GET') {
        return c.redirect('/admin/login', 303);
      }
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Admin access requires Cloudflare Access or an ADMIN_TOKEN' } }, 401);
    }

    c.set('adminIdentity', identity);

    // SPEC §23 — admin is never cached.
    c.header('Cache-Control', 'no-store');
    await next();
  };
}

/** HMAC-SHA256(secret, label) — a browser can hold this but cannot produce it. */
export async function signSession(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(SESSION_LABEL));
  return base64Url(new Uint8Array(mac));
}

export async function setAdminCookie(headers: Headers, secret: string, secure: boolean): Promise<void> {
  const value = await signSession(secret);
  // Path=/ so browser sessions also authenticate /api/admin/* calls.
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
  );
}

export function clearAdminCookie(headers: Headers): void {
  headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function readCookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time compare; length is compared first, which is not a secret here. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
