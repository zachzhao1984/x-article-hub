/**
 * Favicon / app-icon wiring, shared by both document heads.
 *
 * The site emits two independent HTML heads: `src/layouts/Base.astro` for the
 * public pages and the string template in `src/routes/views.ts` for /admin.
 * Icons are declared once here so the two cannot drift apart — an admin page
 * showing a different icon than the article pages is exactly the kind of thing
 * nobody notices until it is wrong in a screenshot.
 *
 * The source is `Logo.png` at the repo root: a dark X behind a warm article card
 * with a blue image. Its checkerboard is baked into RGB pixels. The build script
 * cuts out that background and derives the light and dark marks and all icons.
 *
 * There is deliberately still no `favicon.svg`: a vector `rel="icon"` outranks every
 * raster alternative, so shipping one would silently override the artwork rather than
 * sit beside it.
 */

export interface IconLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
  /**
   * A media query gating the icon, which is how a raster can answer a dark tab bar.
   * A browser that does not understand it uses the ungated entry of the same size,
   * so every gated icon here has an ungated twin.
   */
  media?: string;
}

/** The gate that lets a raster answer a dark tab bar. See `SITE_ICONS`. */
const DARK_SCHEME = '(prefers-color-scheme: dark)';

/**
 * SPEC §33 — a document needs to be identifiable outside the site too: browser
 * tabs, bookmarks, and installed-to-homescreen.
 *
 * The explicit `sizes` on each PNG is not decoration: without it a browser treats
 * a PNG as scalable and may pick the 512 for a 16px tab, which is the blurry
 * outcome the small files exist to avoid.
 *
 * The dark-scheme pair is not a nicety. The X is near-black *by construction*,
 * so on a dark tab bar it is not low contrast, it is absent — measured against the
 * dark theme's #13191c the body sits near a contrast ratio of 1.1. Declaring a
 * second file with `media` is cheaper than the alternative, which would be baking a
 * light tile into the favicon and showing that tile's own edge against a white tab.
 */
export const SITE_ICONS: IconLink[] = [
  { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
  { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
  { rel: 'icon', href: '/favicon-16x16-inverse.png', type: 'image/png', sizes: '16x16', media: DARK_SCHEME },
  { rel: 'icon', href: '/favicon-32x32-inverse.png', type: 'image/png', sizes: '32x32', media: DARK_SCHEME },
  { rel: 'icon', href: '/favicon.ico' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
];

export const MANIFEST_HREF = '/site.webmanifest';

/**
 * The source artwork has a near-black X on transparency, so the tile behind it
 * has to be light or the mark disappears into a dark tab bar. The touch icon
 * already bakes in an opaque light background; this is the same value, used for
 * mobile browser chrome and the installed-app splash.
 */
export const THEME_COLOR = '#f4f1ea';

/**
 * Renders one icon link as HTML. Shared by the string-template head.
 *
 * `media` is here for the same reason the PNG sizes are: the admin head builds its
 * links by string concatenation rather than through Astro, so an attribute the
 * helper does not know about is dropped on one surface only. That is the exact
 * drift this module exists to prevent.
 */
export function iconLinkHtml(icon: IconLink): string {
  const attrs = [
    `rel="${icon.rel}"`,
    `href="${icon.href}"`,
    icon.type ? `type="${icon.type}"` : '',
    icon.sizes ? `sizes="${icon.sizes}"` : '',
    icon.media ? `media="${icon.media}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<link ${attrs}>`;
}
