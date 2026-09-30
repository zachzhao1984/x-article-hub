/**
 * SPEC §24 — admin security.
 *
 * "不要自己实现完整管理员认证" (do not implement full admin auth yourself).
 * Production puts admin behind Cloudflare Access, which authenticates the
 * request before it ever reaches this Worker. All this middleware does is:
 *
 *   1. trust the identity header Cloudflare Access injects
 *      (`Cf-Access-Authenticated-User-Email`), and
 *   2. allow a shared `ADMIN_TOKEN` for local development and `curl` workflows.
 *
 * If neither is present the request is rejected. There is no password store, no
 * user table and no session issuing beyond the dev shim below.
 */

import type { Context } from 'hono';
import { log } from '../lib/logger';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const COOKIE_NAME = 'xah_admin';

export interface AdminIdentity {
  actor: string;
  via: 'cloudflare-access' | 'admin-token';
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

  const token = readAdminToken(c);
  const expected = c.env.ADMIN_TOKEN;
  if (expected && token && timingSafeEqual(token, expected)) {
    return { actor: 'admin-token', via: 'admin-token' };
  }

  return null;
}

export function requireAdmin() {
  return async (c: Context, next: () => Promise<void>) => {
    const identity = resolveIdentity(c);
    if (!identity) {
      log.warn('admin_unauthorized', { path: new URL(c.req.url).pathname });
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Admin access requires Cloudflare Access or an ADMIN_TOKEN' } }, 401);
    }

    c.set('adminIdentity', identity);

    // SPEC §23 — admin is never cached.
    c.header('Cache-Control', 'no-store');
    await next();
  };
}

function readAdminToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();

  const custom = c.req.header('x-admin-token');
  if (custom) return custom.trim();

  const cookie = c.req.header('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setAdminCookie(headers: Headers, secure: boolean): void {
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=1; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
  );
}

export function clearAdminCookie(headers: Headers): void {
  headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Constant-time comparison; lengths are compared first because this is not a secret-length leak. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
