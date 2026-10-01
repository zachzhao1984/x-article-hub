// SPEC §33 — /site.webmanifest
//
// Served dynamically rather than as a static file in public/ so the name and
// the theme colour track SITE_NAME, exactly as /robots.txt tracks SITE_ORIGIN.
// A hardcoded manifest drifts from the site's own configuration the first time
// anyone renames the site.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { THEME_COLOR } from '../config/icons';

const SITE_NAME = (env.SITE_NAME as string) || 'X Article Hub';

export const GET: APIRoute = () => {
  const body = {
    name: SITE_NAME,
    short_name: SITE_NAME.replace(/\s+—.*$/, '').trim() || 'X Articles',
    description: 'A curated, archived and searchable library of X Articles.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The mark is near-black on transparency, so the splash surface must be light
    // or the icon is invisible until the app has painted its own background.
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    // Only the shipped sizes. There is no maskable entry: the source artwork is a
    // floating mark with no full-bleed background, so an Android launcher cropping
    // it to a circle would cut into the glyph. Advertising one anyway would make
    // Chrome pick it and clip the mark on install.
    icons: [
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
