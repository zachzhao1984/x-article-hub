// SPEC §33 — /site.webmanifest
//
// Served dynamically rather than as a static file in public/ so the name and
// the theme colour track SITE_NAME, exactly as /robots.txt tracks SITE_ORIGIN.
// A hardcoded manifest drifts from the site's own configuration the first time
// anyone renames the site.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

const SITE_NAME = (env.SITE_NAME as string) || 'X Article Hub';
const THEME_COLOR = '#1d9bf0';

export const GET: APIRoute = () => {
  const body = {
    name: SITE_NAME,
    short_name: SITE_NAME.replace(/\s+—.*$/, '').trim() || 'X Articles',
    description: 'A curated, archived and searchable library of X Articles.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The tile is a saturated blue with white artwork, so both surfaces want a
    // neutral: white behind the icon, near-black behind the text.
    background_color: '#ffffff',
    theme_color: THEME_COLOR,
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
