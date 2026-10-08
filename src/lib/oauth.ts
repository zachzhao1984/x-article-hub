/**
 * SPEC §43 — OAuth 2.0 authorization code flow with PKCE, for Google.
 *
 * One provider. It is still described as data here rather than inlined into the flow, and
 * the shape is unchanged, because the moment a second provider arrives the difference
 * between them is what belongs in this file — not a second copy of the exchange.
 *
 * ## Why identity is still keyed on the id and not on the address
 *
 * This reason changed when X was removed, so it is worth stating rather than inherited.
 * The old one was that X hands out an address it never verified; with X gone there is no
 * unverified address in play at all, and the argument would be wrong to keep.
 *
 * The reason that survives: **Google lets an account holder change the address on their
 * account.** `sub` is assigned by Google when the account is created and does not move;
 * the address is a property the owner can edit. Keying an account on the address would
 * mean whoever later acquires it inherits the identity — which is the same failure as
 * before, reached by a different road, and no cheaper to reason about.
 *
 * ## Two decisions worth stating because they are invisible below
 *
 * **The access token is never stored.** It lives in a local for the length of one
 * callback, is used to read the profile, and is dropped. Nothing in §43 calls Google
 * afterwards, so persisting it would be a credential with no use and a revocation
 * problem. If a future feature needs provider access, that is the moment to add
 * encrypted-at-rest storage, not now.
 *
 * **`offline.access` is deliberately not requested.** It would hand back a refresh token,
 * and there is nothing here that needs one.
 */

import { AppError } from './errors';
import { siteConfig } from '../config/site';

/**
 * Kept as a union of one rather than collapsed to the bare string `'google'`.
 *
 * The type appears in `user_identities.provider`, in `oauth_states.provider` and in the
 * schema's CHECK constraint, and all three were written against a set of providers rather
 * than a name. Collapsing it now would mean widening all of them again later; adding a
 * provider should be a deliberate one-line change, and this is that line.
 */
export type ProviderId = 'google';

export const PROVIDER_IDS: ProviderId[] = ['google'];

export interface OAuthProfile {
  /** Google's own stable id for this person. The only value identity is ever keyed on. */
  id: string;
  email: string | null;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  readProfile: (accessToken: string) => Promise<OAuthProfile>;
}

/**
 * `openid` is what makes `sub` a stable id; `email` and `profile` are what return an
 * address and a name. All three are basic-profile scopes, which is what keeps this app out
 * of Google's verification queue — nothing here needs the restricted scopes.
 */
const GOOGLE: ProviderConfig = {
  id: 'google',
  label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  readProfile: async (accessToken) => {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new AppError(
        'OAUTH_PROFILE_FAILED',
        `Google profile request returned HTTP ${res.status}`,
        502,
      );
    }
    const body = (await res.json().catch(() => null)) as
      | {
          sub?: string;
          email?: string;
          email_verified?: boolean;
          name?: string;
          picture?: string;
        }
      | null;
    if (!body?.sub) {
      throw new AppError('OAUTH_PROFILE_FAILED', 'Google profile response had no sub', 502);
    }
    // Only kept when Google says it verified it. An address the provider has not verified
    // is a string someone typed, and the distinction is why `email_verified` is checked at
    // all — the profile reader is the only place in §43 where an address is trusted.
    const verified = body.email_verified === true && typeof body.email === 'string';
    return {
      id: body.sub,
      email: verified ? body.email! : null,
      displayName:
        body.name?.trim() || (verified ? body.email!.split('@')[0]! : null) || 'Someone on Google',
      username: verified ? body.email!.split('@')[0]! : null,
      avatarUrl: body.picture?.trim() || null,
    };
  },
};

/**
 * The callback URL, derived from `SITE_ORIGIN` rather than from the incoming request.
 *
 * Google compares this string byte for byte against what is registered, so it cannot be
 * assembled from a `Host` header or a forwarded proto — a request that can choose its own
 * redirect target is an open redirect with an authorization code attached.
 */
export function callbackUri(env: { SITE_ORIGIN?: string }, provider: ProviderId): string {
  return `${siteConfig(env).origin}/auth/${provider}/callback`;
}

export function providerSpec(id: string): ProviderConfig | null {
  return PROVIDER_IDS.includes(id as ProviderId) ? GOOGLE : null;
}

/**
 * Null when the secrets are absent, which is the normal state until an app is registered.
 * Callers render "not configured" rather than a broken button, so a deployment missing
 * this reads as one explained absence rather than a 500.
 */
export function providerConfig(env: Env, provider: ProviderId = 'google'): ProviderConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    ...GOOGLE,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: callbackUri(env, provider),
  };
}

/** The providers actually usable right now, in display order. */
export function configuredProviders(env: Env): ProviderConfig[] {
  return PROVIDER_IDS.map((id) => providerConfig(env, id)).filter(
    (p): p is ProviderConfig => p !== null,
  );
}

export function requireProviderConfig(env: Env, id: string): ProviderConfig {
  const spec = providerSpec(id);
  if (!spec) {
    throw new AppError(
      'OAUTH_UNKNOWN_PROVIDER',
      `"${id}" is not a supported sign-in provider`,
      404,
    );
  }
  const config = providerConfig(env, spec.id);
  if (!config) {
    throw new AppError(
      'OAUTH_NOT_CONFIGURED',
      `${spec.label} sign-in is not configured on this deployment`,
      503,
    );
  }
  return config;
}

/** 256 bits of randomness, base64url. Used for `state`, the PKCE verifier and session tokens. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

/** RFC 7636 §4.2 — the challenge is BASE64URL(SHA256(ASCII(verifier))), unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(
  config: ProviderConfig,
  params: { state: string; challenge: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Redeem the authorization code for an access token, presenting the verifier that matches
 * the challenge sent on `/auth/google/start`.
 *
 * This is the step PKCE exists for: an attacker who intercepts the code — from the
 * redirect URI in a browser history, a shared machine, a referrer leak — still cannot
 * exchange it, because only the process that generated the verifier holds it.
 */
export async function exchangeCode(
  config: ProviderConfig,
  params: { code: string; verifier: string },
): Promise<string> {
  // Client credentials go in the body. The other arrangement this code used to carry as
  // data — HTTP Basic — was X's requirement; Google's token endpoint takes the pair here.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    code_verifier: params.verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Google's own error body names the fault — `redirect_uri_mismatch`, `invalid_grant`
    // — and that is worth keeping for an operator reading the logs. It is not shown to the
    // reader, because on a mismatch it echoes back the redirect URI it was given.
    const detail = await res.text().catch(() => '');
    throw new AppError(
      'OAUTH_TOKEN_EXCHANGE_FAILED',
      `Google token exchange returned HTTP ${res.status}: ${detail.slice(0, 400)}`,
      502,
    );
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!json?.access_token) {
    throw new AppError('OAUTH_TOKEN_EXCHANGE_FAILED', 'Google returned no access_token', 502);
  }
  return json.access_token;
}

/**
 * Where to send the reader after a successful sign-in.
 *
 * Only site-relative paths are honoured. `//evil.example` and `/\evil.example` are both
 * absolute URLs to a browser despite starting with a slash, so a plain "starts with /"
 * check is not enough — hence the second condition. `next` arrives from the query string
 * on a request an attacker can send, and this value is what the callback redirects to.
 */
export function safeRedirectPath(candidate: string | null | undefined, fallback = '/account'): string {
  if (typeof candidate !== 'string') return fallback;
  const raw = candidate.trim();
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // A backslash anywhere is treated as a slash by several URL parsers, so
  // `/\evil.example` and `/a\b` are both refused rather than reasoned about.
  if (raw.includes('\\')) return fallback;
  // Control characters can truncate the value in a header and smuggle a second line.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}

function base64Url(bytes: Uint8Array): string {
  return base64FromBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}