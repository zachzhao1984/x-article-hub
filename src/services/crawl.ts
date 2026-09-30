/**
 * SPEC §38 Phase 2 — the crawl job.
 *
 *   Queue → Browser Run → R2 raw archive → metadata → D1
 *
 * Acceptance (SPEC §38 / §39 Crawl):
 *   - Browser Run successfully fetches the article
 *   - raw HTML archived
 *   - Markdown archived
 *   - retry works
 *
 * Deliberately stops at article status `fetched`. Converting the capture into an
 * ArticleDocument is Phase 3; SPEC §27's whole reason for keeping the raw
 * archive is that Phase 3 must never need to touch X again.
 */

import type { CrawlErrorCode } from '../lib/errors';
import { log } from '../lib/logger';
import { sha256Hex } from '../lib/hash';
import { newId } from '../lib/ids';
import { recordEvent } from '../db/events';
import { setArticleStatus } from '../db/articles';
import { classifyContent, extractAvatarUrl, extractMetadata } from '../jobs/x-selectors';
import type { CrawlMetadata } from '../jobs/x-selectors';
import { runQuickAction, runSnapshot, SCREENSHOT_FORMAT } from './browser';

/** SPEC §27 — bump when the Phase 3 Parser changes; raw is kept so it can re-run. */
export const PARSER_VERSION = 1;

export type CrawlResultKind = 'archived' | 'unchanged' | 'failed';

export interface CrawlOutcome {
  ok: boolean;
  /** SPEC §36 — Browser Run is rate-limited per account; a 429 needs a longer pause. */
  rateLimited?: boolean;
  /** `unchanged` means SPEC §28 said not to create a new version. */
  result: CrawlResultKind;
  errorCode?: CrawlErrorCode;
  errorMessage?: string;
  browserMsUsed?: number | null;
  title?: string | null;
  bodyChars?: number;
  /** Non-fatal: Markdown was archived, but the HTML half of the capture was not. */
  htmlError?: string | null;
}

export interface CrawlInput {
  articleId: string;
  url: string;
  fallbackUsername: string | null;
  actor: string;
}

export async function crawlArticle(env: Env, input: CrawlInput): Promise<CrawlOutcome> {
  const { articleId, url } = input;
  await setArticleStatus(env.DB, articleId, 'fetching');

  const cookies = readCookies(env);

  // --- §7.1 / §36: one browser session, both artifacts ----------------------
  // `/snapshot` with content+markdown costs half of `/markdown` + `/content` and
  // removes the failure mode where the second call is rate-limited and the HTML
  // silently goes missing.
  const formats = ['content', 'markdown'];
  if (env.CRAWL_SCREENSHOT === 'true') formats.push(SCREENSHOT_FORMAT);

  const snap = await runSnapshot(env, { url, cookies, formats });
  let browserMsUsed = snap.browserMsUsed;

  let markdown: string;
  let html: string | null;

  if (snap.ok && snap.data) {
    markdown = snap.data.markdown ?? '';
    html = snap.data.html;
    if (!markdown && html) markdown = html;
  } else if (snap.rateLimited) {
    return failCrawl(
      env,
      input,
      { browserMsUsed },
      snap.errorCode ?? 'PAGE_BLOCKED',
      snap.errorMessage ?? 'Browser Run rate limit reached.',
      true,
    );
  } else {
    // Snapshot unavailable on this deployment: fall back to §7.1's documented
    // two-level ladder rather than losing the capture.
    log.warn('crawl_failed', {
      article_id: articleId,
      error_code: snap.errorCode ?? 'PAGE_BLOCKED',
      error_message: `Snapshot failed, falling back to /markdown. ${snap.errorMessage ?? ''}`,
    });

    const md = await runQuickAction<string>(env, 'markdown', { url, cookies });
    browserMsUsed = (browserMsUsed ?? 0) + (md.browserMsUsed ?? 0);

    if (!md.ok || typeof md.data !== 'string' || md.data.trim().length === 0) {
      return failCrawl(
        env,
        input,
        { browserMsUsed },
        md.errorCode ?? 'PAGE_BLOCKED',
        md.errorMessage ?? 'Browser Run returned no Markdown for the article.',
        md.rateLimited,
      );
    }

    markdown = md.data;
    const content = await runQuickAction<string>(env, 'content', { url, cookies });
    browserMsUsed = (browserMsUsed ?? 0) + (content.browserMsUsed ?? 0);
    html = content.ok && typeof content.data === 'string' && content.data.length > 0 ? content.data : null;
  }

  if (!markdown.trim()) {
    return failCrawl(env, input, { browserMsUsed }, 'EMPTY_CONTENT', 'Browser Run returned an empty capture.');
  }

  // --- SPEC §26: recognise the outcome ----------------------------------------
  const verdict = classifyContent(markdown, html ?? undefined);

  if (verdict.kind === 'non_article') {
    return failCrawl(
      env,
      input,
      { browserMsUsed },
      'ARTICLE_NOT_FOUND',
      'X served its "page does not exist" response for this URL.',
    );
  }

  if (verdict.kind === 'empty') {
    return failCrawl(
      env,
      input,
      { browserMsUsed },
      'EMPTY_CONTENT',
      'X returned an Article with no content (deleted, protected, or unavailable).',
    );
  }

  if (verdict.kind === 'login_wall') {
    return failCrawl(
      env,
      input,
      { browserMsUsed },
      'LOGIN_REQUIRED',
      cookies.length > 0
        ? 'X served its logged-out shell even though session cookies were supplied. The cookies are probably expired or were rejected by X.'
        : 'X served its logged-out login wall. Article bodies on x.com require a signed-in session; set the X_COOKIES_JSON secret, then retry.',
    );
  }

  if (verdict.kind === 'too_small') {
    // SPEC §9.3: deciding whether a capture is worth parsing is the Parser's job,
    // not the crawler's. Archive it and say so, rather than discarding data.
    log.warn('crawl_failed', {
      article_id: articleId,
      error_code: 'EMPTY_CONTENT',
      error_message: `Capture is only ${verdict.bodyChars} chars; archived for inspection.`,
      browser_ms_used: browserMsUsed ?? undefined,
    });
  }

  const htmlError = html ? null : 'Browser Run returned no rendered HTML for this capture.';

  const bodyChars = verdict.kind === 'ok' ? verdict.bodyChars : markdown.length;
  const metadata = extractMetadata(url, markdown, html ?? '', input.fallbackUsername);
  const capturedAt = Date.now();

  // --- SPEC §8: archive raw ---------------------------------------------------
  const archive = await archiveRaw(env, {
    articleId,
    markdown,
    html,
    screenshotBase64: snap.ok && snap.data ? snap.data.screenshotBase64 : null,
    metadata,
    sourceUrl: url,
    capturedAt,
    browserMsUsed,
  });

  // --- SPEC §28: only a changed source produces a new version ----------------
  const latest = await latestVersion(env, articleId);
  const sourceHash = await sha256Hex(markdown);

  if (latest && latest.source_hash === sourceHash) {
    await setArticleStatus(env.DB, articleId, 'fetched');
    log.info('crawl_success', {
      article_id: articleId,
      browser_ms_used: browserMsUsed ?? undefined,
      outcome: 'unchanged',
      version: latest.version,
    });
    return { ok: true, result: 'unchanged', browserMsUsed, title: metadata.title, bodyChars, htmlError };
  }

  const version = (latest?.version ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO article_versions (id, article_id, version, parser_version, source_hash, content_hash, r2_key, captured_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?7)`,
  )
    .bind(newId('ver'), articleId, version, PARSER_VERSION, sourceHash, archive.metadataKey, capturedAt)
    .run();

  // --- metadata onto the article row ------------------------------------------
  // SPEC §27: until Phase 3, the archive is the source of truth. These columns
  // exist so the review UI is usable, and Phase 3 will overwrite them properly.
  await env.DB.prepare(
    `UPDATE articles
        SET title = COALESCE(NULLIF(?2, ''), title),
            author_name = COALESCE(?3, author_name),
            author_username = COALESCE(?4, author_username),
            author_avatar = COALESCE(?5, author_avatar),
            raw_r2_key = ?6,
            published_at = COALESCE(?7, published_at),
            status = 'fetched',
            updated_at = ?8
      WHERE id = ?1`,
  )
    .bind(
      articleId,
      metadata.title ?? '',
      metadata.authorName,
      metadata.authorUsername,
      html ? extractAvatarUrl(html) : null,
      archive.metadataKey,
      metadata.publishedAt ? Date.parse(metadata.publishedAt) || null : null,
      capturedAt,
    )
    .run();

  await recordEvent(
    env.DB,
    articleId,
    'restore',
    input.actor,
    `crawled v${version} — ${bodyChars} chars, browser ${browserMsUsed ?? '?'}ms`,
  );

  log.info('crawl_success', {
    article_id: articleId,
    version,
    parser_version: PARSER_VERSION,
    browser_ms_used: browserMsUsed ?? undefined,
    body_chars: bodyChars,
    status: 'fetched',
  });

  return { ok: true, result: 'archived', browserMsUsed, title: metadata.title, bodyChars, htmlError };
}

interface RawArchive {
  metadataKey: string;
  htmlKey: string | null;
  markdownKey: string;
  screenshotKey: string | null;
}

/**
 * SPEC §8 — archive the raw capture.
 *
 * The spec's directory listing is "recommended", but its rule is explicit:
 * "Raw 永远只追加，不覆盖" (raw is append-only, never overwritten). A fixed
 * `raw/page.html` cannot satisfy both, so each capture gets its own timestamped
 * directory under `raw/` and `metadata.json` names its own siblings. That keeps
 * `articles.raw_r2_key` one stable pointer per article while every earlier
 * capture stays intact for a future Parser (SPEC §27).
 */
async function archiveRaw(
  env: Env,
  args: {
    articleId: string;
    markdown: string;
    html: string | null;
    screenshotBase64: string | null;
    metadata: CrawlMetadata;
    sourceUrl: string;
    capturedAt: number;
    browserMsUsed: number | null;
  },
): Promise<RawArchive> {
  const stamp = new Date(args.capturedAt).toISOString().replace(/[:.]/g, '-');
  const prefix = `articles/${args.articleId}/raw/${stamp}`;

  const htmlKey = args.html ? `${prefix}/page.html` : null;
  const markdownKey = `${prefix}/page.md`;
  const metadataKey = `${prefix}/metadata.json`;
  const screenshotKey = args.screenshotBase64 ? `${prefix}/screenshot.png` : null;

  await Promise.all([
    htmlKey
      ? env.ARCHIVE.put(htmlKey, args.html!, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
      : Promise.resolve(),
    env.ARCHIVE.put(markdownKey, args.markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } }),
    screenshotKey
      ? env.ARCHIVE.put(screenshotKey, base64ToBytes(args.screenshotBase64!), {
          httpMetadata: { contentType: 'image/png' },
        })
      : Promise.resolve(),
    env.ARCHIVE.put(
      metadataKey,
      JSON.stringify(
        {
          sourceUrl: args.sourceUrl,
          capturedAt: new Date(args.capturedAt).toISOString(),
          browserMsUsed: args.browserMsUsed,
          // Self-describing, so a reader needs only this one key from D1.
          files: { html: htmlKey, markdown: markdownKey, screenshot: screenshotKey },
          ...args.metadata,
        },
        null,
        2,
      ),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
    ),
  ]);

  return { metadataKey, htmlKey, markdownKey, screenshotKey };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SPEC §16.4 — "View Raw HTML" / "View raw Markdown". */
export interface RawArchiveRefs {
  metadata: Record<string, unknown> | null;
  markdown: string | null;
  html: string | null;
}

export async function readRawArchive(bucket: R2Bucket, metadataKey: string): Promise<RawArchiveRefs> {
  const metaObj = await bucket.get(metadataKey);
  if (!metaObj) return { metadata: null, markdown: null, html: null };

  const metadata = (await metaObj.json().catch(() => null)) as Record<string, unknown> | null;
  const files = (metadata?.files ?? {}) as { markdown?: string; html?: string | null };

  const [md, html] = await Promise.all([
    files.markdown ? bucket.get(files.markdown) : Promise.resolve(null),
    files.html ? bucket.get(files.html) : Promise.resolve(null),
  ]);

  return {
    metadata,
    markdown: md ? await md.text() : null,
    html: html ? await html.text() : null,
  };
}

async function latestVersion(
  env: Env,
  articleId: string,
): Promise<{ version: number; source_hash: string } | null> {
  return env.DB.prepare(
    `SELECT version, source_hash FROM article_versions WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
  )
    .bind(articleId)
    .first<{ version: number; source_hash: string }>();
}

async function failCrawl(
  env: Env,
  input: CrawlInput,
  result: { browserMsUsed: number | null },
  code: CrawlErrorCode,
  message: string,
  rateLimited = false,
): Promise<CrawlOutcome> {
  await setArticleStatus(env.DB, input.articleId, 'failed');
  log.error('crawl_failed', {
    article_id: input.articleId,
    error_code: code,
    error_message: message,
    browser_ms_used: result.browserMsUsed ?? undefined,
  });

  return {
    ok: false,
    result: 'failed',
    errorCode: code,
    errorMessage: message,
    browserMsUsed: result.browserMsUsed,
    rateLimited,
  };
}

/**
 * SPEC §26 item 2 — session cookies, supplied as a secret.
 *
 * X uses cookie sessions, not HTTP Basic auth, so the documented `authenticate`
 * option cannot log in. An operator exports the `auth_token` / `ct0` cookies from
 * a signed-in browser once and stores them here. Never logged, never returned.
 */
function readCookies(env: Env): unknown[] {
  const raw = env.X_COOKIES_JSON;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    log.warn('crawl_failed', {
      error_code: 'PAGE_BLOCKED',
      error_message: 'X_COOKIES_JSON is not valid JSON; ignoring it.',
    });
    return [];
  }
}
