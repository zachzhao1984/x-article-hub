/**
 * Favicon / app-icon wiring, shared by both document heads.
 *
 * The site emits two independent HTML heads: `src/layouts/Base.astro` for the
 * public pages and the string template in `src/routes/views.ts` for /admin.
 * Icons are declared once here so the two cannot drift apart — an admin page
 * showing a different icon than the article pages is exactly the kind of thing
 * nobody notices until it is wrong in a screenshot.
 *
 * The mark is a hand-tuned raster set from favicon.io — a black X folded from
 * envelope flaps, with a gold star at the crossing. There is deliberately no
 * `favicon.svg`: a vector `rel="icon"` outranks every raster alternative, so
 * shipping one would silently override the artwork. That matters here because the
 * 16px and 32px files are not downscales of the 512 — they were drawn for their
 * size, and the star is legible in the 32px version while a downscale loses it.
 */

export interface IconLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}

/**
 * SPEC §33 — a document needs to be identifiable outside the site too: browser
 * tabs, bookmarks, and installed-to-homescreen.
 *
 * The explicit `sizes` on each PNG is not decoration: without it a browser treats
 * a PNG as scalable and may pick the 512 for a 16px tab, which is the blurry
 * outcome the small files exist to avoid.
 */
export const SITE_ICONS: IconLink[] = [
  { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
  { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
  { rel: 'icon', href: '/favicon.ico' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
];

export const MANIFEST_HREF = '/site.webmanifest';

/**
 * The source artwork is a near-black mark on transparency, so the tile behind it
 * has to be light or the mark disappears into a dark tab bar. The touch icon
 * already bakes in an opaque light background; this is the same value, used for
 * mobile browser chrome and the installed-app splash.
 */
export const THEME_COLOR = '#f4f1ea';

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
