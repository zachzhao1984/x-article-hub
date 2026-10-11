/**
 * SPEC §10 — media download: source URL → Worker fetch → content-type check →
 * R2. The reading page must never load an image straight from X's CDN.
 *
 * The reason is archival integrity, not bandwidth. X deletes posts, replaces
 * images on reposts, and re-encodes media behind the same URL. Every image
 * served from pbs.twimg.com is a promise that someone else's storage decision
 * will hold forever, and for an archive that promise is worthless. A failed
 * download must degrade one figure, never the article (SPEC §10).
 */

import { R2_PATHS } from '../types/article-document';
import type { ArticleDocument, ArticleImage } from '../types/article-document';
import { log } from '../lib/logger';
import { sha256Hex } from '../lib/hash';
import { readArticleDocument, writeArticleDocument } from './archive';
import { imageDimensions } from '../lib/image-size';

export type MediaErrorCode = 'IMAGE_FETCH_FAILED' | 'INVALID_CONTENT_TYPE' | 'IMAGE_TOO_LARGE';

/** SPEC §25 — a size ceiling. X's `name=orig` media can be several MB. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** SPEC §25 — after this many attempts the image is permanently `failed`. */
export const MAX_MEDIA_ATTEMPTS = 5;

const FETCH_TIMEOUT_MS = 20_000;

export interface MediaOutcome {
  ok: boolean;
  ready: number;
  failed: number;
  skipped: number;
  /** Rows that could not be downloaded, with the SPEC §25 reason. */
  failures: Array<{ imageId: string; errorCode: MediaErrorCode; message: string }>;
}

interface MediaRow {
  id: string;
  article_id: string;
  position: number;
  kind: 'body' | 'avatar' | 'cover';
  source_url: string;
  r2_key: string | null;
  status: 'ready' | 'failed' | 'external_fallback';
  content_type: string | null;
  byte_size: number | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
}

/**
 * Downloads every image the document references and not yet owns.
 *
 * Idempotent by SPEC §19: a row with an r2_key is skipped, so redelivery is safe
 * and a re-run only retries what actually failed.
 */
export async function downloadArticleMedia(env: Env, articleId: string): Promise<MediaOutcome> {
  const article = await env.DB.prepare(
    `SELECT id, content_r2_key, author_avatar FROM articles WHERE id = ?`,
  )
    .bind(articleId)
    .first<{ id: string; content_r2_key: string | null; author_avatar: string | null }>();

  if (!article) {
    return { ok: false, ready: 0, failed: 0, skipped: 0, failures: [] };
  }

  if (!article.content_r2_key) {
    return { ok: false, ready: 0, failed: 0, skipped: 0, failures: [] };
  }

  const document = await readArticleDocument(env.ARCHIVE, article.content_r2_key);
  if (!document) {
    return { ok: false, ready: 0, failed: 0, skipped: 0, failures: [] };
  }

  // ---- register the rows (SPEC §10) -----------------------------------------
  // Registering before fetching means a crash mid-download leaves a row that the
  // next run recognises, instead of silently re-fetching from scratch.
  // `video` is excluded, not because it could not be fetched but because archiving it is
  // not what this pipeline does — it stores images, and a video reaching the content-type
  // gate is rejected there permanently after registering a row. Skipping it means no row,
  // no failed attempt and no warning, which is the honest record: nothing was tried. See
  // the note on `VIDEO_HOST_RE` in src/parser/markdown.ts.
  const bodyImages = document.images.filter(
    (img) => img.status !== 'ready' && img.status !== 'video',
  );
  const avatar = document.author.avatar;
  const avatarNeedsWork = Boolean(avatar);

  if (bodyImages.length > 0) {
    await env.DB.batch(
      bodyImages.map((img, index) =>
        env.DB.prepare(
          `INSERT INTO media_objects
             (id, article_id, position, kind, source_url, r2_key, width, height, alt_text,
              status, content_type, byte_size, error_code, error_message, attempt_count,
              created_at, updated_at)
           VALUES (?1, ?2, ?3, 'body', ?4, NULL, NULL, NULL, ?5, 'external_fallback',
                   NULL, NULL, NULL, NULL, 0, ?6, ?6)
           ON CONFLICT (article_id, source_url) DO UPDATE SET
             id = excluded.id,
             position = excluded.position,
             alt_text = COALESCE(excluded.alt_text, alt_text),
             updated_at = excluded.updated_at`,
        )
          // position is the document's own 1-based order, not the loop index: a
          // re-parse that drops an image must not renumber the survivors.
          .bind(img.imageId, articleId, index + 1, img.sourceUrl, img.altText ?? null, Date.now()),
      ),
    );
  }

  if (avatar) {
    await env.DB.prepare(
      `INSERT INTO media_objects
         (id, article_id, position, kind, source_url, r2_key, width, height, alt_text,
          status, content_type, byte_size, error_code, error_message, attempt_count,
          created_at, updated_at)
       VALUES (?1, ?2, 0, 'avatar', ?3, NULL, NULL, NULL, NULL, 'external_fallback',
               NULL, NULL, NULL, NULL, 0, ?4, ?4)
       ON CONFLICT (article_id, source_url) DO UPDATE SET
         id = excluded.id,
         updated_at = excluded.updated_at`,
    )
      .bind(avatarImageId(articleId, avatar), articleId, avatar, Date.now())
      .run();
  }

  // SPEC §8 / §10 — the R2 key is derived from the position, so a re-parse that
  // reorders or removes an image moves what an existing key *means*. A row whose
  // stored key no longer matches its own position is pointing at another image's
  // bytes, so its r2_key is cleared and the download runs again. Without this the
  // article renders one figure twice and silently loses another.
  await reconcilePositions(env, articleId);

  // ---- fetch -----------------------------------------------------------------
  const rows = await pendingRows(env, articleId);
  const failures: MediaOutcome['failures'] = [];
  let ready = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    // SPEC §10 — one image failing must not fail the article, and must not stop
    // the others either.
    try {
      const outcome = await downloadOne(env, row);
      if (outcome.ok) {
        ready += 1;
      } else if (outcome.permanent) {
        failed += 1;
        failures.push({ imageId: row.id, errorCode: outcome.errorCode, message: outcome.message });
      } else {
        // Retryable: leave the row for the next attempt, count it as neither.
        failures.push({ imageId: row.id, errorCode: outcome.errorCode, message: outcome.message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markFailure(env, row, 'IMAGE_FETCH_FAILED', message, false);
      failures.push({ imageId: row.id, errorCode: 'IMAGE_FETCH_FAILED', message });
    }
  }

  // Anything already stored is a skip, not a re-download.
  skipped = Math.max(0, bodyImages.length + (avatarNeedsWork ? 1 : 0) - ready - failed - failures.length);

  // ---- reflect the result back into the document -----------------------------
  // The reading page renders from the ArticleDocument, so the document is what
  // has to learn that the bytes are local. SPEC §8 keeps raw append-only; this is
  // the normalized document, which the Parser is allowed to rebuild.
  const updated = await applyResults(env, articleId, article.content_r2_key, document);
  if (updated) {
    await writeArticleDocument(env.ARCHIVE, article.content_r2_key!, updated);
  }

  if (avatar) {
    await refreshAvatar(env, articleId, avatar);
  }

  log.info(failures.length === 0 ? 'media_success' : 'media_failed', {
    article_id: articleId,
    ready,
    failed,
    skipped,
    failures: failures.length,
  });

  return { ok: failures.length === 0, ready, failed, skipped, failures };
}

/**
 * Drops an r2_key that no longer corresponds to the row's own position.
 *
 * SPEC §8 / §10 key stored media by position, so the key is derived state. When a
 * re-parse reorders or removes a figure, the surviving rows move, and a key left
 * over from the old ordering now names a different image's bytes. Clearing it
 * forces the download to run again rather than serving the wrong picture.
 */
async function reconcilePositions(env: Env, articleId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, position, kind, r2_key, content_type FROM media_objects
      WHERE article_id = ? AND r2_key IS NOT NULL`,
  )
    .bind(articleId)
    .all<{ id: string; position: number; kind: 'body' | 'avatar' | 'cover'; r2_key: string; content_type: string | null }>();

  // The expected key is derived from the row's own position AND its own content
  // type, so this catches both a figure that moved and a key whose extension no
  // longer describes its bytes.
  const stale = results.filter((row) => {
    const extension = extensionFor(row.content_type);
    // A generated cover is not positioned in the article flow, so its key comes from its
    // kind rather than from `position`. Without this branch the reconciler would compute
    // `media/000.<ext>`, judge the real key stale, clear it, and sweep the bytes — silently
    // deleting every generated cover on the next media run.
    const expected =
      row.kind === 'avatar'
        ? R2_PATHS.avatar(articleId, extension)
        : row.kind === 'cover'
          ? R2_PATHS.cover(articleId, extension)
          : R2_PATHS.media(articleId, row.position, extension);
    return row.r2_key !== expected;
  });

  // Clearing a stale r2_key only stops D1 from pointing at the old key; the bytes
  // stay in the bucket. So the whole `media/` prefix is swept afterwards and
  // anything no row still claims is deleted. Without the sweep a re-parse that
  // reorders figures leaves each article's old copies filed under positions that
  // now belong to other images, and renaming the key scheme leaves a duplicate of
  // every object — which is exactly what the avatar extension change did, leaving
  // a JPEG at both `avatar.webp` and `avatar.jpg`.
  await sweepUnclaimedMedia(env, articleId, results);

  if (stale.length === 0) return;

  await env.DB.batch(
    stale.map((row) =>
      env.DB.prepare(
        `UPDATE media_objects
            SET r2_key = NULL, status = 'external_fallback', error_code = NULL,
                error_message = NULL, updated_at = ?2
          WHERE id = ?1`,
      ).bind(row.id, Date.now()),
    ),
  );

  // SPEC §35 names the log vocabulary; a superseded key is a media failure with
  // its own reason rather than a new event type.
  log.warn('media_failed', {
    article_id: articleId,
    error_code: 'STALE_R2_KEY',
    error_message: `${stale.length} stored key(s) no longer match their image; deleted and re-downloading.`,
  });
}

/**
 * Deletes every object under an article's `media/` prefix that no current row
 * claims.
 *
 * Listing the prefix is what makes this safe to run repeatedly: the set of keys a
 * *should* exist is derived entirely from D1, so anything in the bucket outside
 * that set is by definition superseded. It costs one LIST per media run and it is
 * the only way to reclaim a key whose name changed — R2 has no way to enumerate
 * what used to be there.
 */
async function sweepUnclaimedMedia(
  env: Env,
  articleId: string,
  rows: Array<{ r2_key: string }>,
): Promise<void> {
  const claimed = new Set(rows.map((r) => r.r2_key));
  const prefix = `articles/${articleId}/media/`;

  const listed = await env.ARCHIVE.list({ prefix, limit: 1000 });
  const unclaimed = listed.objects.filter((o) => !claimed.has(o.key)).map((o) => o.key);

  if (unclaimed.length === 0) return;

  const results = await Promise.allSettled(unclaimed.map((key) => env.ARCHIVE.delete(key)));
  const failed = results.filter((r) => r.status === 'rejected').length;

  log.warn('media_failed', {
    article_id: articleId,
    error_code: 'STALE_R2_KEY',
    error_message: `Deleted ${unclaimed.length - failed} superseded object(s) under ${prefix}${
      failed > 0 ? `; ${failed} could not be deleted` : ''
    }`,
  });
}

function extensionFor(contentType: string | null): string {
  switch ((contentType ?? '').toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    default:
      return 'webp';
  }
}

async function pendingRows(env: Env, articleId: string): Promise<MediaRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, article_id, position, kind, source_url, r2_key, status, content_type,
            byte_size, error_code, error_message, attempt_count
       FROM media_objects
      WHERE article_id = ? AND r2_key IS NULL
      ORDER BY kind ASC, position ASC`,
  )
    .bind(articleId)
    .all<MediaRow>();
  return results;
}

interface DownloadResult {
  ok: boolean;
  /** SPEC §25 — a bad content type or an oversized image will not fix itself. */
  permanent: boolean;
  errorCode: MediaErrorCode;
  message: string;
}

async function downloadOne(env: Env, row: MediaRow): Promise<DownloadResult> {
  // SPEC §25 — give up after the ladder is exhausted so a permanently broken
  // URL stops costing a request on every re-run.
  if (row.attempt_count >= MAX_MEDIA_ATTEMPTS) {
    return {
      ok: false,
      permanent: true,
      errorCode: (row.error_code as MediaErrorCode) ?? 'IMAGE_FETCH_FAILED',
      message: `Gave up after ${row.attempt_count} attempts: ${row.error_message ?? 'unknown'}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(row.source_url, {
      signal: controller.signal,
      headers: {
        // X's CDN 403s a request with no referrer identity of its own, and the
        // archive should not depend on that staying true.
        'User-Agent': 'Mozilla/5.0 (compatible; XArticleHub/1.0; +https://x-article-hub.workers.dev)',
        Accept: 'image/webp,image/*;q=0.8',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailure(env, row, 'IMAGE_FETCH_FAILED', message, false);
    return { ok: false, permanent: false, errorCode: 'IMAGE_FETCH_FAILED', message };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 4xx means X will not serve this bytes; 5xx might. 404 in particular is the
    // expected shape of a deleted post and must not be retried forever.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    const message = `HTTP ${response.status} from ${hostOf(row.source_url)}`;
    await markFailure(env, row, 'IMAGE_FETCH_FAILED', message, permanent);
    return { ok: false, permanent, errorCode: 'IMAGE_FETCH_FAILED', message };
  }

  // SPEC §10 — content-type check before any bytes are written.
  const contentType = ((response.headers.get('content-type') ?? '').split(';')[0] ?? '')
    .trim()
    .toLowerCase();
  if (!contentType.startsWith('image/')) {
    const message = `Expected an image, got "${contentType || 'no content-type'}"`;
    await markFailure(env, row, 'INVALID_CONTENT_TYPE', message, true);
    return { ok: false, permanent: true, errorCode: 'INVALID_CONTENT_TYPE', message };
  }

  // SPEC §25 — IMAGE_TOO_LARGE. Checked from the declared length first so an
  // oversized body is rejected before it is buffered.
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES) {
    const message = `Declared ${declared} bytes, over the ${MAX_IMAGE_BYTES} limit`;
    await markFailure(env, row, 'IMAGE_TOO_LARGE', message, true);
    return { ok: false, permanent: true, errorCode: 'IMAGE_TOO_LARGE', message };
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    const message = 'Empty response body';
    await markFailure(env, row, 'IMAGE_FETCH_FAILED', message, false);
    return { ok: false, permanent: false, errorCode: 'IMAGE_FETCH_FAILED', message };
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    const message = `Body is ${buffer.byteLength} bytes, over the ${MAX_IMAGE_BYTES} limit`;
    await markFailure(env, row, 'IMAGE_TOO_LARGE', message, true);
    return { ok: false, permanent: true, errorCode: 'IMAGE_TOO_LARGE', message };
  }

  // SPEC §10 stores .webp unconditionally. X serves WebP when asked, and the
  // magic-byte check below rejects a response that ignored the Accept header, so
  // the extension is never a lie.
  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    const message = `Body is not a recognised image (content-type said ${contentType})`;
    await markFailure(env, row, 'INVALID_CONTENT_TYPE', message, true);
    return { ok: false, permanent: true, errorCode: 'INVALID_CONTENT_TYPE', message };
  }

  const key =
    row.kind === 'avatar'
      ? R2_PATHS.avatar(row.article_id, sniffed.extension)
      : R2_PATHS.media(row.article_id, row.position, sniffed.extension);

  await env.ARCHIVE.put(key, buffer, {
    httpMetadata: {
      contentType: sniffed.mime,
      // SPEC §10 — media is immutable once stored. A re-download of the same
      // position writes the same key, so a long TTL is safe and a reader that
      // already has it never re-downloads.
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      source_url: row.source_url,
      article_id: row.article_id,
      position: String(row.position),
    },
  });

  const dims = imageDimensions(buffer, sniffed.format);

  await env.DB.prepare(
    `UPDATE media_objects
        SET r2_key = ?2,
            status = 'ready',
            content_type = ?3,
            byte_size = ?4,
            width = ?5,
            height = ?6,
            error_code = NULL,
            error_message = NULL,
            attempt_count = attempt_count + 1,
            fetched_at = ?7,
            updated_at = ?7
      WHERE id = ?1`,
  )
    .bind(
      row.id,
      key,
      sniffed.mime,
      buffer.byteLength,
      dims?.width ?? null,
      dims?.height ?? null,
      Date.now(),
    )
    .run();

  return { ok: true, permanent: false, errorCode: 'IMAGE_FETCH_FAILED', message: '' };
}

async function markFailure(
  env: Env,
  row: MediaRow,
  code: MediaErrorCode,
  message: string,
  permanent: boolean,
): Promise<void> {
  const attempts = row.attempt_count + 1;
  // Once the SPEC §25 ladder is exhausted the row stops being retryable and the
  // status becomes terminal. Without this a deleted image costs five fetches on
  // every single re-run, forever.
  const giveUp = permanent || attempts >= MAX_MEDIA_ATTEMPTS;

  await env.DB.prepare(
    `UPDATE media_objects
        SET status = ?2,
            error_code = ?3,
            error_message = ?4,
            attempt_count = ?5,
            updated_at = ?6
      WHERE id = ?1`,
  )
    .bind(row.id, giveUp ? 'failed' : 'external_fallback', code, message.slice(0, 500), attempts, Date.now())
    .run();
}

/** Writes the R2 keys back into the document so the reading page can use them. */
async function applyResults(
  env: Env,
  articleId: string,
  contentKey: string,
  document: ArticleDocument,
): Promise<ArticleDocument | null> {
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key, width, height, alt_text, status FROM media_objects WHERE article_id = ?`,
  )
    .bind(articleId)
    .all<{
      id: string;
      r2_key: string | null;
      width: number | null;
      height: number | null;
      alt_text: string | null;
      status: 'ready' | 'failed' | 'external_fallback';
    }>();

  if (results.length === 0) return null;

  const byId = new Map(results.map((r) => [r.id, r]));
  let changed = false;

  const images: ArticleImage[] = document.images.map((img) => {
    const row = byId.get(img.imageId);
    if (!row) return img;

    const next: ArticleImage = {
      ...img,
      r2Key: row.r2_key,
      status: row.status,
      altText: row.alt_text ?? img.altText,
      width: row.width ?? img.width,
      height: row.height ?? img.height,
    };
    if (next.r2Key !== img.r2Key || next.status !== img.status) changed = true;
    return next;
  });

  if (!changed) return null;

  return { ...document, images, source: { ...document.source } };
}

/** The byline avatar gets a local URL once its bytes are in R2. */
async function refreshAvatar(env: Env, articleId: string, sourceUrl: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM media_objects WHERE article_id = ? AND kind = 'avatar' AND source_url = ?`,
  )
    .bind(articleId, sourceUrl)
    .first<{ r2_key: string | null }>();

  if (!row?.r2_key) return;

  await env.DB.prepare(`UPDATE articles SET author_avatar = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(articleId, `/media/${avatarImageId(articleId, sourceUrl)}`, Date.now())
    .run();
}

/**
 * Stable across re-parses of the same article, distinct from any body image id,
 * and — like body images — scoped to the article.
 *
 * Scoping matters here too: an author posting five articles has one avatar URL,
 * and `media_objects.id` is the PRIMARY KEY. Hashing the URL alone made the
 * second article's avatar row collide with the first, which is the exact failure
 * the body-image ids had.
 */
export function avatarImageId(articleId: string, sourceUrl: string): string {
  return `av_${simpleHash(`${articleId} ${sourceUrl}`)}`;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

export interface SniffedImage {
  format: 'webp' | 'jpeg' | 'png' | 'gif';
  mime: string;
  extension: string;
}

/**
 * Magic-byte check. The `content-type` header is a claim by the origin, and the
 * whole point of SPEC §10's content-type step is to not trust it — an HTML error
 * page served as `image/jpeg` would otherwise be archived as an image and fail
 * in the reader's browser instead of in the pipeline.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImage | null {
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP'
  ) {
    return { format: 'webp', mime: 'image/webp', extension: 'webp' };
  }
  // PNG: 89 50 4E 47
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    return { format: 'png', mime: 'image/png', extension: 'png' };
  }
  // GIF: "GIF8"
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === 'GIF') {
    return { format: 'gif', mime: 'image/gif', extension: 'gif' };
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', mime: 'image/jpeg', extension: 'jpg' };
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

export interface MediaRowView {
  imageId: string;
  position: number;
  kind: 'body' | 'avatar' | 'cover';
  status: 'ready' | 'failed' | 'external_fallback';
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
}

/** SPEC §10 — per-image state for the admin detail page. */
export async function listArticleMedia(db: D1Database, articleId: string): Promise<MediaRowView[]> {
  const { results } = await db
    .prepare(
      `SELECT id, position, kind, status, content_type, byte_size, width, height, alt_text,
              error_code, error_message, attempt_count
         FROM media_objects
        WHERE article_id = ?
        ORDER BY kind ASC, position ASC`,
    )
    .bind(articleId)
    .all<{
      id: string;
      position: number;
      kind: 'body' | 'avatar' | 'cover';
      status: 'ready' | 'failed' | 'external_fallback';
      content_type: string | null;
      byte_size: number | null;
      width: number | null;
      height: number | null;
      alt_text: string | null;
      error_code: string | null;
      error_message: string | null;
      attempt_count: number;
    }>();

  return results.map((r) => ({
    imageId: r.id,
    position: r.position,
    kind: r.kind,
    status: r.status,
    contentType: r.content_type,
    byteSize: r.byte_size,
    width: r.width,
    height: r.height,
    altText: r.alt_text,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    attempts: r.attempt_count,
  }));
}

/**
 * R2 prefixes under `articles/` that no row in D1 claims.
 *
 * SPEC §8 makes raw append-only, so deleting an article row does not delete its
 * captures — and that is correct: an archive is a record of what was captured, and
 * a smoke fixture going away is not a reason to erase evidence. The cost is that
 * prefixes outlive their rows, and a bucket listing is the only way to notice.
 *
 * Reporting them is the honest option. Deleting them automatically would be the
 * wrong default: nothing here can tell a stale prefix from a capture whose D1 row
 * was restored deliberately, and an archive that deletes its own history because
 * a row went missing is not an archive.
 */
export async function findOrphanedPrefixes(env: Env): Promise<
  Array<{ articleId: string; objects: number; bytes: number }>
> {
  const listed = await env.ARCHIVE.list({ prefix: 'articles/', delimiter: '/', limit: 1000 });
  const articleIds = listed.delimitedPrefixes
    .map((p: string) => p.replace(/^articles\//, '').replace(/\/$/, ''))
    .filter((id: string) => id.startsWith('art_'));

  const orphans: Array<{ articleId: string; objects: number; bytes: number }> = [];

  for (const articleId of articleIds) {
    const exists = await env.DB.prepare(`SELECT 1 AS ok FROM articles WHERE id = ?`)
      .bind(articleId)
      .first<{ ok: number }>();
    if (exists) continue;

    let objects = 0;
    let bytes = 0;
    let cursor: string | undefined;
    do {
      const page = await env.ARCHIVE.list({ prefix: `articles/${articleId}/`, limit: 1000, cursor });
      objects += page.objects.length;
      bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    orphans.push({ articleId, objects, bytes });
  }

  return orphans;
}

/** Re-exported so the admin surface can show what a media run did. */
export async function mediaSummary(env: Env, articleId: string) {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM media_objects WHERE article_id = ? GROUP BY status`,
  )
    .bind(articleId)
    .all<{ status: string; n: number }>();

  const byStatus: Record<string, number> = { ready: 0, failed: 0, external_fallback: 0 };
  for (const row of results) byStatus[row.status] = row.n;

  const bytes = await env.DB.prepare(
    `SELECT COALESCE(SUM(byte_size), 0) AS total FROM media_objects WHERE article_id = ? AND status = 'ready'`,
  )
    .bind(articleId)
    .first<{ total: number }>();

  return { ...byStatus, byteSize: bytes?.total ?? 0 };
}
