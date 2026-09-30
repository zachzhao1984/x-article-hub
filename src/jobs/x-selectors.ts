/**
 * SPEC §7.4 / §26 — every X-specific selector and heuristic lives here.
 *
 * SPEC §7.4 is explicit: X's DOM belongs to an external site, so selectors must
 * not be scattered through business logic. SPEC §26 adds the design rule:
 *
 *   semantic selector → fallback selector → content extraction heuristic
 *
 * never `if (selector === "some.class")`.
 *
 * Nothing in this file knows about D1, R2 or queues. It is pure recognition.
 */

// --- §7.2 / §7.3: what a usable result looks like --------------------------

/**
 * SPEC §26 item 10 — a successful crawl of an X Article must contain prose.
 * Tuned against real captured output, so treat these as heuristic constants and
 * revisit them whenever a capture surprises us.
 */
export const CONTENT_LIMITS = {
  /** Below this many characters, treat the capture as a wall, not an article. */
  minBodyChars: 400,
  /** A login wall is short. Anything longer is probably a real (if thin) page. */
  loginWallMaxChars: 600,
  /** Longer than this and we are looking at navigation chrome, not the article. */
  maxBodyChars: 400_000,
} as const;

/**
 * SPEC §26 item 1 / LOGIN_REQUIRED — X serves a logged-out shell. These markers
 * appear in the rendered DOM and in the extracted markdown, so either can be
 * checked without depending on the other.
 */
export const LOGIN_WALL_MARKERS = [
  'mode=login',
  'mode=signup',
  '/i/jf/onboarding',
  'Log in',
  'Sign up',
  'Continue with phone',
  'Continue with Google',
] as const;

/** A real Article page renders one of these containers. */
export const ARTICLE_CONTENT_SELECTORS = [
  // Semantic first: the article body container X renders for long-form posts.
  '[data-testid="twitter-text-longform"]',
  'article [data-testid="longformRichTextView"]',
  '[data-testid="tweetText"]',
  // Fallback: any article element on the page.
  'article',
  'main article',
] as const;

/** SPEC §26 item 6 — an empty Article is a distinct outcome from a blocked page. */
export const EMPTY_CONTENT_MARKERS = [
  'This post is unavailable',
  "This Post may be deleted",
  'Something went wrong',
  'This page doesn’t exist',
  "This page doesn't exist",
] as const;

/** SPEC §26 item 5 — a non-Article post is not an error, it is a different thing. */
export const NON_ARTICLE_MARKERS = [
  'Something went wrong. Try reloading',
  'Hmm...this page doesn’t exist',
] as const;

// --- metadata extraction (§7.2) -------------------------------------------

export interface CrawlMetadata {
  title: string | null;
  authorName: string | null;
  authorUsername: string | null;
  description: string | null;
  publishedAt: string | null;
}

/**
 * `/markdown` emits a YAML frontmatter block derived from the page's `<title>`
 * and `<meta>` tags. X populates those server-side even when the body is walled,
 * so this is the one metadata source available without a Parser (Phase 3).
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Minimal YAML scalar reader — frontmatter here is flat `key: "value"` pairs.
 *
 * Keys can themselves be quoted (`"og:title": "..."`), which is exactly how
 * /markdown emits them, so the colon *inside* a quoted key must not be treated
 * as the separator.
 */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = FRONTMATTER_RE.exec(markdown.trimStart());
  if (!match?.[1]) return {};

  const out: Record<string, string> = {};

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let key: string;
    let rest: string;

    const quotedKey = /^"([^"]+)"\s*:\s*(.*)$/.exec(line);
    if (quotedKey) {
      key = quotedKey[1]!;
      rest = quotedKey[2]!;
    } else {
      const sep = line.indexOf(':');
      if (sep <= 0) continue; // a bare `meta:` group header is not a field
      key = line.slice(0, sep).trim();
      rest = line.slice(sep + 1).trim();
    }

    let value = rest;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value.replace(/\\"/g, '"');
  }

  return out;
}

/**
 * X appends its own branding to the document title. Both observed forms:
 *   "Title | 灰原学姐 (@HaibaraCrypto) on X"
 *   "Title / X"
 * Neither belongs in a headline or an OG tag.
 */
export function stripXTitleSuffix(title: string): string {
  // Observed on a real capture:
  //   "\u5c0f\u767d\u5165\u95e8\u7f8e\u80a1\u6307\u5357\uff08\u5efa\u8bae\u6536\u85cf\u5b66\u4e60\uff09 | \u7070\u539f\u5b66\u59d0 (@HaibaraCrypto) on X"
  // The @handle makes the trailing author segment unambiguous, and it must not be
  // matched with \w -- that class does not cover non-Latin names, which is
  // exactly the case that matters here.
  const withHandle = /^(.*?)\s*[|/]\s*[^|/]*@([A-Za-z0-9_]{1,15})[^|/]*\s+on\s+X\s*$/i.exec(title);
  if (withHandle?.[1]) return withHandle[1].trim();

  // "Title | Author on X" -- only stripped when a separator marks the boundary,
  // so a real title that merely ends in the word "X" survives.
  const withOn = /^(.*?)\s*[|/]\s*.*\s+on\s+X\s*$/i.exec(title);
  if (withOn?.[1]) return withOn[1].trim();

  // "Title / X" and "Title | X"
  return title.replace(/\s*[|/]\s*X\s*$/i, '').trim();
}

/** `"Andrej Karpathy (@karpathy) / X"` → display name + username. */
export function splitXTitle(title: string): { name: string | null; username: string | null } {
  const at = /^(.*?)\s*\(@([A-Za-z0-9_]{1,15})\)/.exec(title);
  if (at?.[1] && at[2]) return { name: at[1].trim() || null, username: at[2] };
  return { name: null, username: null };
}

/**
 * `<time datetime="...">` in the rendered HTML, or an absolute date in the
 * markdown. X renders this server-side, so it is worth trying both.
 */
export function extractPublishedAt(html: string, markdown: string): string | null {
  const timeTag = /<time[^>]+datetime="([^"]+)"/i.exec(html);
  if (timeTag?.[1] && !Number.isNaN(Date.parse(timeTag[1]))) return timeTag[1];

  const mdDate = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\b/.exec(markdown);
  if (mdDate?.[1] && !Number.isNaN(Date.parse(mdDate[1]))) return mdDate[1];

  return null;
}

/**
 * SPEC §7.2 — the author avatar, not the cover image.
 *
 * On an X Article, `og:image` is the article's cover image, not a face. Using it
 * as the avatar put a stock photo where someone's portrait belongs. X serves
 * avatars from a distinct CDN path, so that is what is matched first, and the
 * Parser independently recovers the real avatar from X's author chip.
 */
export function extractAvatarUrl(html: string): string | null {
  // X's avatar CDN path anywhere in the document.
  const fromCdn = /(["'(])(https?:\/\/pbs\.twimg\.com\/profile_images\/[^"')\s]+)\1/i.exec(html);
  if (fromCdn?.[2]) return fromCdn[2];

  const patterns = [
    /<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/i,
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
}

// --- §26: the recognition ladder ------------------------------------------

export type ContentVerdict =
  | { kind: 'ok'; bodyChars: number }
  | { kind: 'login_wall' }
  | { kind: 'empty' }
  | { kind: 'non_article' }
  | { kind: 'too_small'; bodyChars: number };

/**
 * SPEC §26's ladder, applied to what Browser Run actually returned.
 *
 * Order matters: a logged-out X page contains login links *and* looks small, so
 * the wall has to be recognised before the length heuristic or every blocked
 * fetch would be misreported as EMPTY_CONTENT.
 */
export function classifyContent(markdown: string, html?: string): ContentVerdict {
  const haystack = `${markdown}\n${html ?? ''}`;
  const bodyChars = markdown.replace(FRONTMATTER_RE, '').trim().length;

  // Order matters, and not only because of the size heuristic.
  //
  // The "post was deleted" and "no such page" strings only render for an
  // *authenticated* viewer. Seeing one therefore proves we are logged in, which
  // means the login prompts on the same page are chrome rather than the wall.
  // Checking the wall first would misreport a deleted article as LOGIN_REQUIRED
  // and send an operator to fix cookies for an article that simply does not exist.
  if (NON_ARTICLE_MARKERS.some((m) => haystack.includes(m))) return { kind: 'non_article' };
  if (EMPTY_CONTENT_MARKERS.some((m) => haystack.includes(m))) return { kind: 'empty' };

  const loginHits = LOGIN_WALL_MARKERS.filter((m) => haystack.includes(m)).length;
  if (loginHits >= 2 || (loginHits >= 1 && bodyChars <= CONTENT_LIMITS.loginWallMaxChars)) {
    return { kind: 'login_wall' };
  }

  if (bodyChars > CONTENT_LIMITS.maxBodyChars) return { kind: 'too_small', bodyChars };

  if (bodyChars < CONTENT_LIMITS.minBodyChars) return { kind: 'too_small', bodyChars };

  return { kind: 'ok', bodyChars };
}

/** A bare profile URL has no headline, so its <title> is trustworthy identity. */
function isProfileUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(url);
}

/** Builds the full metadata set from both captures plus the canonical URL. */
export function extractMetadata(
  url: string,
  markdown: string,
  html: string,
  fallbackUsername: string | null,
): CrawlMetadata {
  const fm = parseFrontmatter(markdown);
  const fromTitle = fm.title ? splitXTitle(fm.title) : { name: null, username: null };

  const urlUsername = /x\.com\/([A-Za-z0-9_]{1,15})\/article\//.exec(url)?.[1] ?? null;

  // `og:title` is the clean human title; the `<title>` tag is X's own, which
  // appends the author and platform ("... | 灰原学姐 (@HaibaraCrypto) on X").
  // Prefer og:title, and strip the suffix if only `<title>` is available.
  const rawTitle = fm['og:title'] ?? fm.title ?? null;

  return {
    title: rawTitle ? stripXTitleSuffix(rawTitle) : null,
    authorName: fromTitle.name ?? fm.author ?? null,
    // The URL is authoritative for the handle: it is the dedup key's own input.
    authorUsername: urlUsername ?? fromTitle.username ?? fallbackUsername,
    description: fm.description ?? fm['og:description'] ?? null,
    publishedAt: extractPublishedAt(html, markdown),
  };
}
