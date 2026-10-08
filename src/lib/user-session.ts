/**
 * SPEC §43 — the reader's session: a cookie, a hashed row, and the two functions that
 * move between them.
 *
 * The cookie carries 256 bits of randomness and nothing else — no user id, no role, no
 * expiry. Everything the Worker needs to decide anything is a column on the row the
 * token points at, which means changing a role or revoking a session takes effect on the
 * next request rather than whenever some signed blob happens to expire. The admin
 * cookie is the opposite design (an HMAC of a shared secret, no row); that one is
 * appropriate when there is exactly one possible identity, and wrong the moment there
 * are accounts.
 *
 * `SameSite=Lax` is load-bearing, not a default worth keeping. The sign-in round trip
 * ends with a top-level GET redirect back from Google or X, and `Lax` is the only value
 * that sends the cookie on that navigation. `Strict` — which is the stricter-sounding
 * choice, and the one `setAdminCookie` in src/middleware/admin-auth.ts uses for the
 * admin cookie — would withhold it and every sign-in would land on `/account` still
 * signed out, with no error anywhere to explain why.
 */

import {
  deleteSession,
  deleteSessionsForUser,
  findSessionWithUser,
  insertSession,
  // Aliased on import: this module also exports its own `touchSession`, and an
  // unqualified `touchSession(db, ...)` below would otherwise call itself.
  touchSession as touchSessionStmt,
  type SessionWithUser,
  type UserRow,
} from '../db/users';
import { sha256Hex } from './hash';
import { randomToken } from './oauth';

/**
 * `Path=/` rather than `/auth`, so the session authenticates API calls and the account
 * page alike; `HttpOnly` so no script can read it; `Secure` whenever the deployment is
 * on https, which is the only condition under which `Lax` is worth anything anyway.
 */
export const USER_COOKIE = 'xah_user';

/** 30 days. Long because the only thing an account can currently do is exist. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an unused `/auth/:provider/start` stays redeemable. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface ResolvedSession extends SessionWithUser {
  /** The raw cookie value, kept only so a caller can delete or extend this exact row. */
  token: string;
  tokenHash: string;
}

/**
 * The value as it appears in a `Cookie` header.
 *
 * Returns null for the empty string rather than '' — an empty cookie is a client that
 * cleared it, not a session whose token happens to be blank, and hashing '' would look
 * up a row that does not exist while looking like it did the work.
 */
export function readUserCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== USER_COOKIE) continue;
    const value = rest.join('=');
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      // A cookie that is not valid percent-encoding is a client sending nonsense.
      // Returning the raw value keeps the lookup a miss instead of throwing, so a
      // malformed cookie degrades to "signed out" rather than a 500.
      return value;
    }
  }
  return null;
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * The address, hashed with a server-side pepper.
 *
 * Salted with a secret because a bare hash of an IPv4 address is reversible by anyone
 * willing to try 2^32 candidates, which would make storing it a privacy measure in name
 * only. The pepper lives in a secret binding, so a D1 dump plus this table still yields
 * nothing without access to the Worker.
 */
async function hashAddress(pepper: string | undefined, address: string | null): Promise<string | null> {
  if (!address || !pepper) return null;
  return sha256Hex(`${pepper}:${address}`);
}

export interface CreateSessionInput {
  db: D1Database;
  userId: string;
  now: number;
  userAgent?: string | null;
  address?: string | null;
  pepper?: string | undefined;
}

/**
 * Mint a session and return the token to put in the cookie.
 *
 * The token is never logged and never returned anywhere else. D1 stores only its hash,
 * so the row cannot be replayed even by someone who reads the table.
 */
export async function createSession(input: CreateSessionInput): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const tokenHash = await hashSessionToken(token);
  const expiresAt = input.now + SESSION_TTL_MS;

  await insertSession(input.db, {
    tokenHash,
    userId: input.userId,
    now: input.now,
    expiresAt,
    // Truncated rather than stored whole: the full User-Agent carries a build number and
    // a platform version that identify a machine as precisely as the address does, and
    // none of it is read by anything.
    userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
    ipHash: await hashAddress(input.pepper, input.address ?? null),
  }).run();

  return { token, expiresAt };
}

/**
 * Resolve a cookie to a session, or to null.
 *
 * `now` is a parameter because the expiry comparison must use one clock reading for the
 * whole request. A session read at 23:59:59.999 and compared again at 00:00:00.001
 * would otherwise be simultaneously valid and expired within a single request.
 *
 * Returns null for an unknown token, a revoked token and an expired token
 * indistinguishably, which is the correct answer for all three: the caller has no way to
 * act differently on any of them, and telling a reader which one happened turns the
 * endpoint into a token oracle.
 */
export async function resolveSession(
  db: D1Database,
  cookieHeader: string | null | undefined,
  now: number,
): Promise<ResolvedSession | null> {
  const token = readUserCookie(cookieHeader);
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  const found = await findSessionWithUser(db, tokenHash, now);
  if (!found) return null;
  return { ...found, token, tokenHash };
}

/** Cheap enough to call on the pages that care about staleness, too hot for every request. */
export async function touchSession(db: D1Database, tokenHash: string, now: number): Promise<void> {
  await touchSessionStmt(db, tokenHash, now).run();
}

export async function signOut(db: D1Database, tokenHash: string): Promise<void> {
  await deleteSession(db, tokenHash).run();
}

export async function signOutEverywhere(db: D1Database, userId: string): Promise<void> {
  await deleteSessionsForUser(db, userId).run();
}

export function setUserCookie(headers: Headers, token: string, expiresAt: number, secure: boolean): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  headers.append(
    'Set-Cookie',
    `${USER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
      secure ? '; Secure' : ''
    }`,
  );
}

export function clearUserCookie(headers: Headers, secure: boolean): void {
  headers.append(
    'Set-Cookie',
    `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
  );
}

/**
 * The shape the header and `/account` need, and nothing more.
 *
 * A deliberate narrowing: nothing outside this module needs `created_at`, `last_seen_at`
 * or the row's `ip_hash`, and a wide `UserRow` travelling into the view layer is how an
 * address ends up in a template by accident.
 */
export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  role: UserRow['role'];
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    email: user.email,
    role: user.role,
  };
}