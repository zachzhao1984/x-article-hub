/**
 * SPEC §43 — OAuth 2.0 authorization code flow with PKCE, for X and Google.
 *
 * Both providers speak the same protocol, so they are described as data here and the
 * whole flow is written once. The two genuine differences between them are carried as
 * fields rather than as branches through the flow:
 *
 *   - X requires HTTP Basic client authentication on the token exchange even when PKCE
 *     is in use, because PKCE protects the *code* and says nothing about the client
 *     proving it is the client. Google takes client_id/client_secret in the form body.
 *   - Each provider describes a person differently, so each has its own reader that
 *     normalises into one `OAuthProfile`.
 *
 * Two decisions worth stating because they are invisible in the code below:
 *
 * **Provider access tokens are never stored.** They are held in a local for the length
 * of one callback, used to read the profile, and dropped. Nothing in §43 calls a
 * provider API afterwards, so persisting them would be storing a credential with no
 * use and a revocation problem. If a future feature needs provider access, that is the
 * moment to add encrypted-at-rest storage, not now.
 *
 * **Nothing here trusts an address.** `OAuthProfile.email` is carried because the user
 * asked for it to be kept, and is used in exactly one place: display. See the note
 * above `user_identities` in migration 0008 for why it cannot be an identity.
 */

import { AppError } from './errors';
import { siteConfig } from '../config/site';

export type ProviderId = 'x' | 'google';

export const PROVIDER_IDS: ProviderId[] = ['x', 'google'];

export interface OAuthProfile {
  /** The provider's own stable id. The only value identity is ever keyed on. */
  id: string;
  email: string | null;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
}

interface ProviderSpec {
  id: ProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** `basic` = client credentials in an Authorization header; `body` = in the form. */
  tokenAuth: 'basic' | 'body';
  readProfile: (accessToken: string) => Promise<OAuthProfile>;
}

export interface ProviderConfig extends ProviderSpec {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * X requires both scopes on `/2/users/me`, and requests neither any permission to post
 * nor to read anyone else's timeline. `offline.access` is deliberately absent: it would
 * hand back a refresh token, and there is nothing here that needs one.
 *
 * The user id is requested as `username` + `profile_image_url` rather than resolved from
 * the access token, because the token is opaque and has to be exchanged to learn
 * anything at all.
 */
const X: ProviderSpec = {
  id: 'x',
  label: 'X',
  authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
  tokenUrl: 'https://api.x.com/2/oauth2/token',
  scope: 'users.read tweet.read',
  tokenAuth: 'basic',
  readProfile: async (accessToken) => {
    const url =
      'https://api.x.com/2/users/me?user.fields=profile_image_url,username,name';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new AppError('OAUTH_PROFILE_FAILED', `X profile request returned HTTP ${res.status}`, 502);
    }
    const body = (await res.json().catch(() => null)) as
      | { data?: { id?: string; name?: string; username?: string; profile_image_url?: string } }
      | null;
    const data = body?.data;
    if (!data?.id) {
      throw new AppError('OAUTH_PROFILE_FAILED', 'X profile response had no user id', 502);
    }
    return {
      id: data.id,
      // X's `email` field is present only when the app holds the right permission tier,
      // and when present X has never verified it. Null is the normal case and is fine.
      email: null,
      displayName: data.name?.trim() || data.username?.trim() || 'Someone on X',
      username: data.username?.trim() || null,
      avatarUrl: data.profile_image_url?.trim() || null,
    };
  },
};

const GOOGLE: ProviderSpec = {
  id: 'google',
  label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // `openid` is what makes `sub` a stable id; the other two are what return an address
  // and a name. All three are basic-profile scopes, which is what keeps this app out of
  // Google's verification queue.
  scope: 'openid email profile',
  tokenAuth: 'body',
  readProfile: async (accessToken) => {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new AppError('OAUTH_PROFILE_FAILED', `Google profile request returned HTTP ${res.status}`, 502);
    }
    const body = (await res.json().catch(() => null)) as
      | { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
      | null;
    if (!body?.sub) {
      throw new AppError('OAUTH_PROFILE_FAILED', 'Google profile response had no sub', 502);
    }
    // Only kept when Google says it verified it. An unverified address is still a
    // string someone typed, and the distinction is the whole reason email cannot be an
    // identity key.
    const verified = body.email_verified === true && typeof body.email === 'string';
    return {
      id: body.sub,
      email: verified ? body.email! : null,
      displayName: body.name?.trim() || (verified ? body.email!.split('@')[0]! : null) || 'Someone on Google',
      username: verified ? body.email!.split('@')[0]! : null,
      avatarUrl: body.picture?.trim() || null,
    };
  },
};

const SPECS: Record<ProviderId, ProviderSpec> = { x: X, google: GOOGLE };

/**
 * The callback URL, derived from `SITE_ORIGIN` rather than from the incoming request.
 *
 * Both providers compare this string byte for byte against what is registered, so it
 * cannot be assembled from a `Host` header or a forwarded proto — a request that can
 * choose its own redirect target is an open redirect with an OAuth code attached.
 */
export function callbackUri(env: { SITE_ORIGIN?: string }, provider: ProviderId): string {
  return `${siteConfig(env).origin}/auth/${provider}/callback`;
}

export function providerSpec(id: string): ProviderSpec | null {
  return PROVIDER_IDS.includes(id as ProviderId) ? SPECS[id as ProviderId] : null;
}

/**
 * Null when the provider's secrets are absent, which is the normal state until someone
 * registers an app. Callers render "not configured" rather than a broken button, so a
 * half-finished setup shows up as one disabled provider instead of a 500.
 */
export function providerConfig(env: Env, id: ProviderId): ProviderConfig | null {
  const spec = SPECS[id];
  const clientId = id === 'x' ? env.X_CLIENT_ID : env.GOOGLE_CLIENT_ID;
  const clientSecret = id === 'x' ? env.X_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { ...spec, clientId, clientSecret, redirectUri: callbackUri(env, id) };
}

/** The providers that are actually usable right now, in display order. */
export function configuredProviders(env: Env): ProviderConfig[] {
  return PROVIDER_IDS.map((id) => providerConfig(env, id)).filter((p): p is ProviderConfig => p !== null);
}

export function requireProviderConfig(env: Env, id: string): ProviderConfig {
  const spec = providerSpec(id);
  if (!spec) {
    throw new AppError('OAUTH_UNKNOWN_PROVIDER', `"${id}" is not a supported sign-in provider`, 404);
  }
  const config = providerConfig(env, spec.id);
  if (!config) {
    throw new AppError('OAUTH_NOT_CONFIGURED', `${spec.label} sign-in is not configured on this deployment`, 503);
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
 * Redeem the authorization code for an access token, presenting the verifier that
 * matches the challenge sent on `/auth/:provider/start`.
 *
 * This is the step PKCE exists for: an attacker who intercepts the code (from the
 * redirect URI in a browser history, a shared machine, a referrer leak) still cannot
 * exchange it, because only the process that generated the verifier holds it.
 */
export async function exchangeCode(
  config: ProviderConfig,
  params: { code: string; verifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    code_verifier: params.verifier,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (config.tokenAuth === 'basic') {
    const encoded = base64FromString(`${config.clientId}:${config.clientSecret}`);
    headers.Authorization = `Basic ${encoded}`;
  } else {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }

  const res = await fetch(config.tokenUrl, { method: 'POST', headers, body: body.toString() });
  if (!res.ok) {
    // The provider's own error body names the fault (bad_verifier, redirect_uri
    // mismatch), and that is worth keeping for an operator reading logs — but it is
    // not shown to the reader, because it echoes the client secret on a bad Basic.
    const detail = await res.text().catch(() => '');
    throw new AppError(
      'OAUTH_TOKEN_EXCHANGE_FAILED',
      `${config.label} token exchange returned HTTP ${res.status}: ${detail.slice(0, 400)}`,
      502,
    );
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!json?.access_token) {
    throw new AppError('OAUTH_TOKEN_EXCHANGE_FAILED', `${config.label} returned no access_token`, 502);
  }
  return json.access_token;
}

/**
 * Where to send the reader after a successful sign-in.
 *
 * Only site-relative paths are honoured. `//evil.example` and `/\evil.example` are
 * both absolute URLs to a browser despite starting with a slash, so a plain
 * "starts with /" check is not enough — hence the second condition. `next` arrives from
 * the query string on a request an attacker can send, and this value is what the
 * callback redirects to.
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

function base64FromString(input: string): string {
  return base64FromBytes(new TextEncoder().encode(input));
}