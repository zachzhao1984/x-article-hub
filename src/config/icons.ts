/**
 * Favicon / app-icon wiring, shared by both document heads.
 *
 * The site emits two independent HTML heads: `src/layouts/Base.astro` for the
 * public pages and the string template in `src/routes/views.ts` for /admin.
 * Icons are declared once here so the two cannot drift apart — an admin page
 * showing a different icon than the article pages is exactly the kind of thing
 * nobody notices until it is wrong in a screenshot.
 *
 * The mark itself lives in `public/favicon.svg` and is rasterised from it, so
 * the vector file stays the single source of truth for every size.
 */

export interface IconLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}

/**
 * SPEC §33 — a document needs to be identifiable outside the site too: browser
 * tabs, bookmarks, and installed-to-homescreen. SVG first because it is sharp
 * at any density, then the multi-size ICO for engines without SVG support.
 */
export const SITE_ICONS: IconLink[] = [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'icon', href: '/favicon.ico' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
];

export const MANIFEST_HREF = '/site.webmanifest';

/**
 * X brand blue, matching the favicon tile. Drives the browser chrome on mobile
 * and the splash colour of an installed PWA.
 */
export const THEME_COLOR = '#1d9bf0';

/** Renders one icon link as HTML. Shared by the string-template head. */
export function iconLinkHtml(icon: IconLink): string {
  const attrs = [
    `rel="${icon.rel}"`,
    `href="${icon.href}"`,
    icon.type ? `type="${icon.type}"` : '',
    icon.sizes ? `sizes="${icon.sizes}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<link ${attrs}>`;
}
