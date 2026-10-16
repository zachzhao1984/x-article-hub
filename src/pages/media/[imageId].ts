// SPEC §10 — serve archived media out of R2.
//
// The reading page points every image at /media/:imageId. That indirection is
// what makes the archive self-sufficient: the document stores an image id, not a
// CDN URL, so where the bytes physically live is a decision this route gets to
// make rather than something baked into archived data.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params }) => {
  const bucket = env.ARCHIVE as unknown as R2Bucket;
  const db = env.DB as unknown as D1Database;
  const imageId = params.imageId ?? '';

  // The bytes at an image id are immutable — the id is content-addressed by
  // insertion time and we never overwrite it. So the CDN can be trusted with
  // the whole object for the full max-age the header says, which keeps the archive's
  // covers off the Worker on the second and every subsequent view.
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheUrl = new URL(`/media/${imageId}`, 'https://x-article-hub.zachzhao.workers.dev');
  const cached = await cache.match(cacheUrl);
  if (cached) return cached;

  const row = await db
    .prepare(`SELECT r2_key, content_type, byte_size FROM media_objects WHERE id = ?`)
    .bind(imageId)
    .first<{ r2_key: string | null; content_type: string | null; byte_size: number | null }>();

  if (!row?.r2_key) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const object = await bucket.get(row.r2_key);
  if (!object) {
    return new Response('Media object missing from storage', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', row.content_type ?? 'application/octet-stream');
  // SPEC §10 — media is immutable at its key, so it can be cached hard.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (row.byte_size) headers.set('Content-Length', String(row.byte_size));
  // Nothing is executed from an image route; say so explicitly.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  const response = new Response(object.body, { headers });
  await cache.put(cacheUrl, response.clone());
  return response;
};
