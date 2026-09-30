/**
 * SPEC §5 — URL import design.
 *
 * `normalizeArticleUrl` is the only place that decides whether a pasted string is
 * an X Article we can archive, and what its identity key is. Dedup (SPEC §5.3)
 * is keyed off the `canonicalUrl` it returns, so this function must be stable:
 * the same input must always produce the same output, on any machine, forever.
 */

import type { ImportErrorCode } from './errors';

/** Hosts that serve X content and therefore resolve to `x.com`. */
const HOST_ALIASES: Record<string, string> = {
  'x.com': 'x.com',
  'www.x.com': 'x.com',
  'mobile.x.com': 'x.com',
  'twitter.com': 'x.com',
  'www.twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
};

/** Query params X appends for tracking; they never change which article this is. */
const TRACKING_PARAMS = new Set([
  's',
  't',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'cx',
  'twclid',
  'gclid',
  'fbclid',
  '_ga',
  'guccounter',
  'guce_referrer',
  'guce_referrer_sig',
]);

/** X usernames: 1–15 chars, alphanumerics and underscore. */
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const ARTICLE_ID_RE = /^\d{1,25}$/;

export interface NormalizedUrl {
  /** Cleaned, https, no fragment, no tracking params. What the admin pasted, normalized. */
  sourceUrl: string;
  /** Dedup key (SPEC §5.3). Unique constraint target on `articles.canonical_url`. */
  canonicalUrl: string;
  /** Extracted from `/<username>/article/<id>`; null when the path is not a known article shape. */
  xArticleId: string | null;
  username: string | null;
}

/**
 * On success `username` and `xArticleId` are guaranteed non-null: the function
 * only returns `ok: true` for the `/<username>/article/<id>` shape.
 */
export type NormalizeResult =
  | { ok: true; value: NormalizedUrl & { xArticleId: string; username: string } }
  | { ok: false; code: ImportErrorCode; message: string };

/** SPEC §16.2 — split a textarea / TXT paste into candidate lines. */
export function splitUrlInput(input: string): string[] {
  return input
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * SPEC §5.2, in order:
 *   1. trim whitespace          5. delete fragment
 *   2. URL decode               6. normalize x.com / twitter.com aliases
 *   3. force https              7. extract canonical URL
 *   4. delete tracking params
 */
export function normalizeArticleUrl(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: 'EMPTY_INPUT', message: 'URL is empty' };

  // Paste-with-scheme is the happy path; bare "x.com/..." is common enough to accept.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: `Not a valid URL: ${trimmed}` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'INVALID_URL', message: `Unsupported protocol: ${url.protocol}` };
  }

  const host = HOST_ALIASES[url.hostname.toLowerCase()];
  if (!host) {
    return {
      ok: false,
      code: 'UNSUPPORTED_HOST',
      message: `Only x.com / twitter.com article URLs are supported, got: ${url.hostname}`,
    };
  }

  // (4) tracking params, (5) fragment
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = '';

  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
  // X handles are case-insensitive: /Foo/article/1 and /foo/article/1 are the same
  // article, so the username must be lowercased before it becomes a dedup key.
  const username = segments[0] && USERNAME_RE.test(segments[0]) ? segments[0].toLowerCase() : null;

  // X serves long-form posts at /<username>/article/<id>. Anything else on the
  // host (a profile, a status permalink, the homepage) is not archivable here.
  const isArticlePath = segments.length === 3 && segments[1] === 'article' && !!username;
  const xArticleId =
    isArticlePath && segments[2] && ARTICLE_ID_RE.test(segments[2]) ? segments[2] : null;

  if (!isArticlePath || !xArticleId) {
    return {
      ok: false,
      code: 'NOT_AN_ARTICLE',
      message: `Expected https://x.com/<username>/article/<id>, got: ${url.pathname}`,
    };
  }

  const canonicalUrl = `https://x.com/${username}/article/${xArticleId}`;
  const sourceUrl = `https://x.com/${username}/article/${xArticleId}${url.search}`;

  return { ok: true, value: { sourceUrl, canonicalUrl, xArticleId, username } };
}

/**
 * `decodeURIComponent` throws on malformed sequences like `%zz`; a pasted URL is
 * user input, so fall back to the original text instead of failing the import.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** SPEC §17.1 — `/article/:slug`. Built at import time, unique per article id. */
export function buildArticleSlug(username: string, xArticleId: string): string {
  return `${slugify(username)}-${xArticleId}`;
}

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}
