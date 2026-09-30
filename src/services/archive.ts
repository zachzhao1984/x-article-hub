/**
 * SPEC §8 — R2 access for the normalized document.
 *
 * Raw archives are written by the crawl job (Phase 2) and are append-only.
 * This module only *reads* the normalized document, which is what the reading
 * page renders.
 */

import type { ArticleDocument } from '../types/article-document';

export async function readArticleDocument(bucket: R2Bucket, key: string): Promise<ArticleDocument | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  try {
    return (await object.json()) as ArticleDocument;
  } catch {
    // A corrupt document should degrade the page, not 500 it.
    return null;
  }
}

export async function writeArticleDocument(
  bucket: R2Bucket,
  key: string,
  doc: ArticleDocument,
): Promise<void> {
  await bucket.put(key, JSON.stringify(doc), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

/** SPEC §8 — mirrored to D1 so the reading page can reach it via the CDN. */
export async function serveDocumentFromR2(bucket: R2Bucket, key: string): Promise<Response | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // SPEC §23 — the document is immutable for a given version key.
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, immutable',
    },
  });
}
