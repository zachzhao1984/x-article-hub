// SPEC §33 — /robots.txt
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

const ORIGIN = ((env.SITE_ORIGIN as string) || 'https://x-article-hub.workers.dev').replace(/\/+$/, '');

export const GET: APIRoute = () => {
  const body = [
    'User-agent: *',
    'Allow: /',
    // SPEC §23 — admin must never be indexed.
    'Disallow: /admin',
    'Disallow: /admin/',
    'Disallow: /api/',
    'Disallow: /search',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
};
