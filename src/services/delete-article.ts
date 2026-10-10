/**
 * SPEC §8 / §16 — hard delete: remove an article and everything that belongs to it.
 *
 * ## Why this is a service and not a route handler
 *
 * It has to run in a specific order, and the order is the whole correctness argument. The
 * D1 row is the only pointer to the archived objects — every R2 key is derived from the
 * article id (`articles/{id}/...`, SPEC §8) — so deleting the row first loses the ability to
 * find anything that is not already recorded in a child table. The R2 sweep therefore comes
 * first, and a failure there aborts before the row is touched.
 *
 * The D1 children are left to `ON DELETE CASCADE`, which every one of the six referencing
 * tables declares and D1 honours (`PRAGMA foreign_keys` is on). Listing them here would be a
 * second, silently-diverging copy of the schema: a table added later would be deleted
 * correctly by the cascade and missed by the list.
 *
 * ## What "everything" means
 *
 *   R2   every object under `articles/{id}/` — raw captures, every version, every image and
 *        avatar. This is the part no cascade can reach.
 *   D1   the article row, and through it `article_versions`, `media_objects`, `crawl_jobs`,
 *        `curation_events`, `article_tags` and `article_metrics`.
 */

import { log } from '../lib/logger';

export interface DeleteResult {
  articleId: string;
  slug: string | null;
  title: string | null;
  /** R2 objects swept. */
  objects: number;
  bytes: number;
  /** Child rows the cascade removed, for the confirmation message. */
  rows: {
    versions: number;
    media: number;
    jobs: number;
    events: number;
    tags: number;
    metrics: number;
  };
  /** True when no `articles` row matched, so only the R2 sweep could have run. */
  rowMissing: boolean;
}

/**
 * Count what the delete would remove, without removing it.
 *
 * Used to describe the operation before it happens, and to make the confirmation dialog
 * state a number rather than a warning. Reading before writing also means the counts in the
 * result are the real ones: after the cascade they would all be zero.
 */
export async function summarizeForDelete(
  env: Env,
  articleId: string,
): Promise<{ objects: number; bytes: number } & DeleteResult['rows']> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM article_versions WHERE article_id = ?1) AS versions,
       (SELECT COUNT(*) FROM media_objects    WHERE article_id = ?1) AS media,
       (SELECT COUNT(*) FROM crawl_jobs       WHERE article_id = ?1) AS jobs,
       (SELECT COUNT(*) FROM curation_events  WHERE article_id = ?1) AS events,
       (SELECT COUNT(*) FROM article_tags     WHERE article_id = ?1) AS tags,
       (SELECT COUNT(*) FROM article_metrics  WHERE article_id = ?1) AS metrics`,
  )
    .bind(articleId)
    .first<DeleteResult['rows']>();

  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: `articles/${articleId}/`, limit: 1000, cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    versions: row?.versions ?? 0,
    media: row?.media ?? 0,
    jobs: row?.jobs ?? 0,
    events: row?.events ?? 0,
    tags: row?.tags ?? 0,
    metrics: row?.metrics ?? 0,
    objects,
    bytes,
  };
}

/**
 * Delete the article and every trace of it.
 *
 * Throws if the R2 sweep fails, before any row is removed. Deliberate: a partial delete
 * that has dropped the D1 row but left the objects is unrecoverable by any tool here —
 * `findOrphanedPrefixes` would report the prefix as an orphan, but nothing maps it back to
 * what it was, and the admin has no way to know whether it belonged to the article just
 * removed or to one removed a year ago.
 *
 * A missing `articles` row is not an error. The R2 sweep still runs, which makes this usable
 * for cleaning up an orphaned prefix whose row is already gone — the case
 * `findOrphanedPrefixes` reports and cannot act on.
 */
export async function deleteArticleEverywhere(env: Env, articleId: string, actor: string): Promise<DeleteResult> {
  const article = await env.DB.prepare(`SELECT id, slug, title FROM articles WHERE id = ?1`)
    .bind(articleId)
    .first<{ id: string; slug: string | null; title: string | null }>();

  // Counted before anything is written; after the cascade these are all zero.
  const counts = await summarizeForDelete(env, articleId);

  // --- R2 first. A failure here must leave the D1 row in place, because the row is the only
  // thing that makes the remaining objects findable.
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: `articles/${articleId}/`, limit: 1000, cursor });
    await Promise.all(page.objects.map((o) => env.ARCHIVE.delete(o.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // --- then the row. Every child table cascades from it.
  await env.DB.prepare(`DELETE FROM articles WHERE id = ?1`).bind(articleId).run();

  log.warn('article_deleted', {
    article_id: articleId,
    actor,
    slug: article?.slug ?? null,
    had_row: article !== null,
    r2_objects: counts.objects,
    r2_bytes: counts.bytes,
    versions: counts.versions,
    media: counts.media,
    jobs: counts.jobs,
    events: counts.events,
    tags: counts.tags,
    metrics: counts.metrics,
  });

  return {
    articleId,
    slug: article?.slug ?? null,
    title: article?.title ?? null,
    objects: counts.objects,
    bytes: counts.bytes,
    rows: {
      versions: counts.versions,
      media: counts.media,
      jobs: counts.jobs,
      events: counts.events,
      tags: counts.tags,
      metrics: counts.metrics,
    },
    rowMissing: article === null,
  };
}
