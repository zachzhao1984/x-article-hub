/**
 * The logo system: the artwork in `Logo.jpg`, the rasters generated from it, and the
 * two surfaces that show it.
 *
 * The regression this file exists for: every icon the site used to serve was a
 * transparent PNG that still had the grey/white checkerboard from the source JPEG baked
 * in at full opacity. `Logo.jpg` cannot hold transparency, so that checkerboard is real
 * pixels in it — and every browser tab, iOS home screen and Android launcher drew a grey
 * checkerboard around the mark. Nothing about the files said so. They declared an alpha
 * channel, which is the first thing a reader checks, so the assertions below decode
 * pixels instead of reading the header.
 */

import { describe, expect, it } from 'vitest';
import { layout } from '../../src/routes/views';
import { MANIFEST_HREF, SITE_ICONS, THEME_COLOR, iconLinkHtml } from '../../src/config/icons';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { alphaAt, coverage, decodePng, maxChroma, meanLuminance, rgbAt } from './png';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

/** The icons that sit on whatever the browser puts behind them. */
const TRANSPARENT = [
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-16x16-inverse.png',
  'favicon-32x32-inverse.png',
  'logo-mark.png',
  'logo-mark-inverse.png',
  'icon-192.png',
  'icon-512.png',
];

describe('site icons (SPEC §33)', () => {
  it('advertises the small tab sizes explicitly', () => {
    // Without `sizes` a browser may treat a PNG as scalable and pick the 512 for a
    // 16px tab, which throws away the file that exists for that size.
    const byHref = new Map(SITE_ICONS.map((i) => [i.href, i]));
    expect(byHref.get('/favicon-16x16.png')).toMatchObject({ rel: 'icon', sizes: '16x16' });
    expect(byHref.get('/favicon-32x32.png')).toMatchObject({ rel: 'icon', sizes: '32x32' });
    expect(byHref.get('/apple-touch-icon.png')).toMatchObject({ rel: 'apple-touch-icon' });
  });

  it('ships no SVG icon, which would silently outrank the raster set', () => {
    // A vector `rel="icon"` takes precedence over every raster alternative. The source
    // artwork has no vector form, so one shipping here would override the rasters and
    // none of the generated sizes would ever reach a browser. `mask-icon` is a different
    // rel and does not take part in that ranking, which is why the pinned tab stays.
    expect(SITE_ICONS.some((i) => i.href.endsWith('.svg'))).toBe(false);
    expect(existsSync(resolve('public/favicon.svg'))).toBe(false);
    expect(source('src/layouts/Base.astro')).toContain('rel="mask-icon" href="/safari-pinned-tab.svg"');
  });

  it('puts every icon in the admin head, not just the public pages', () => {
    // Two independent head templates exist. An admin page showing a different favicon
    // than an article page is the drift this guards against.
    const html = layout({ title: 'Articles', active: 'articles', siteName: 'X Article Hub' }, '');
    for (const icon of SITE_ICONS) {
      expect(html).toContain(iconLinkHtml(icon));
    }
    expect(html).toContain(`href="${MANIFEST_HREF}"`);
    expect(html).toContain(`content="${THEME_COLOR}"`);
  });

  it('ships every file the head and the manifest advertise', () => {
    // Derived from the config rather than restated, because a list written out by hand
    // is exactly where the next added icon goes missing.
    for (const icon of SITE_ICONS) {
      const path = resolve('public', icon.href.replace(/^\//, ''));
      expect(existsSync(path), `${icon.href} is advertised but missing`).toBe(true);
    }
    for (const file of ['/icon-192.png', '/icon-512.png', '/safari-pinned-tab.svg']) {
      expect(existsSync(resolve('public', file.slice(1))), `${file} is advertised but missing`).toBe(true);
    }
  });

  it('has each advertised PNG at the size it claims', () => {
    // A 16x16 `sizes` on a 512px file is a lie the browser will believe.
    for (const icon of SITE_ICONS) {
      if (!icon.sizes || !icon.href.endsWith('.png')) continue;
      const [w, h] = icon.sizes.split('x').map(Number);
      const img = decodePng(icon.href.replace(/^\//, ''));
      expect([img.width, img.height], `${icon.href} does not match sizes="${icon.sizes}"`).toEqual([w, h]);
    }
  });

  it('is transparent where the browser supplies the background', () => {
    // The assertion the old assets fail, with the reason in the message: their alpha ran
    // to 255 at every pixel because the source JPEG's checkerboard was baked in. Reading
    // only the IHDR colour type would have called those files fine.
    for (const name of TRANSPARENT) {
      const img = decodePng(name);
      expect(img.hasAlpha, `${name} is opaque everywhere — a baked-in background, not a matte`).toBe(true);
      // A mark with a stray transparent corner is not the same as a cut-out silhouette.
      expect(alphaAt(img, 0, 0), `${name} has no transparent corner`).toBe(0);
    }
  });

  it('draws something in each transparent icon', () => {
    // The other half of the same check: an alpha channel that reaches 0 is also what a
    // blank canvas has, so each file needs opaque pixels of its own — and must not be a
    // solid square, which is what a failed cut-out looks like.
    for (const name of TRANSPARENT) {
      const covered = coverage(decodePng(name));
      expect(covered, `${name} has no opaque pixels`).toBeGreaterThan(20);
      expect(covered, `${name} is nearly solid — the silhouette was not cut out`).toBeLessThan(85);
    }
  });

  it('has an Apple touch icon with no transparent pixels, or iOS renders the corners black', () => {
    // iOS masks the touch icon itself and draws transparency as black, so a transparent
    // corner ships as a black corner. Measured on the pixels rather than on the presence
    // of an alpha channel: the file may carry an alpha channel and still be opaque
    // throughout, which is what satisfying this actually requires.
    const img = decodePng('apple-touch-icon.png');
    expect([img.width, img.height]).toEqual([180, 180]);
    expect(img.hasAlpha, 'apple-touch-icon must not carry a transparent pixel').toBe(false);

    // The tile is the same colour as the browser chrome and the installed-app splash.
    // An icon cut from a different paper than the splash behind it reads as a fault,
    // and a second copy of the value would be a second place to forget to update it.
    const expected = THEME_COLOR.replace('#', '');
    const hex = (rgb: readonly [number, number, number]) =>
      rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    expect(hex(rgbAt(img, 0, 0)), 'the touch icon tile is not THEME_COLOR').toBe(expected);
    expect(hex(rgbAt(img, 179, 179)), 'the touch icon tile is not THEME_COLOR').toBe(expected);
    expect(source('scripts/build-logo.py')).toContain("ROOT / 'src' / 'config' / 'icons.ts'");
  });

  it('answers a dark tab bar with the inverse rather than with the same file', () => {
    // A favicon cannot adapt on its own, so `media` is the only way a raster can, and a
    // gated icon is useless without an ungated twin to fall back to.
    const gated = SITE_ICONS.filter((icon) => icon.media);
    expect(gated.length).toBeGreaterThan(0);
    for (const icon of gated) {
      expect(icon.media).toContain('prefers-color-scheme: dark');
      const twin = SITE_ICONS.find((other) => other.sizes === icon.sizes && !other.media);
      expect(twin, `${icon.href} is gated with no ungated twin`).toBeDefined();
      expect(twin?.href, `${icon.href} points at itself`).not.toBe(icon.href);
      // The gate has to survive into the HTML. The admin head builds links by string
      // concatenation rather than through Astro, so an attribute the helper does not know
      // about lands on one surface only — the exact drift this config module prevents.
      expect(iconLinkHtml(icon)).toContain(`media="${icon.media}"`);
    }
  });

  it('keeps the .ico carrying the three sizes a legacy reader looks for', () => {
    // The PNGs win in every current browser, so the .ico is only reached by a legacy one
    // — and a stale .ico is invisible to every check above, because nothing in the
    // document claims a size for it.
    const ico = readFileSync(resolve('public/favicon.ico'));
    expect([...ico.subarray(0, 4)], 'favicon.ico is not an ICO').toEqual([0, 0, 1, 0]);
    const frames = ico.readUInt16LE(4);
    expect(frames).toBeGreaterThan(1);
    const sizes: number[] = [];
    for (let i = 0; i < frames; i++) {
      // Directory entries are 16 bytes; a dimension byte of 0 means 256.
      const width = ico[6 + i * 16] ?? 0;
      sizes.push(width === 0 ? 256 : width);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  it('keeps a light theme colour, since the mark is near-black', () => {
    // A dark theme colour behind a near-black mark is the icon disappearing into the
    // browser chrome. This is a value assertion, not a format one: any colour that is
    // genuinely light passes, a saturated blue does not.
    const hex = THEME_COLOR.replace('#', '');
    const channels: number[] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(24);
    expect(channels.reduce((sum, c) => sum + c, 0) / 3).toBeGreaterThan(180);
  });

  it('keeps the pinned-tab mask a pure alpha stencil', () => {
    // Safari paints the alpha channel with the user's own toolbar colour. Any colour of
    // its own is ignored at best, and a solid background renders a pinned tab as a black
    // square, so the file must be black-and-white only.
    const markup = source('public/safari-pinned-tab.svg').replace(/<!--[\s\S]*?-->/g, '');
    const colors = [...markup.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) {
      expect(['#000', '#fff', 'none'], `pinned tab must not use ${color}`).toContain(color);
    }
    expect(markup).not.toMatch(/[Gg]radient/);
    expect(markup).toMatch(/viewBox="0 0 64 64"/);
    expect(markup).toMatch(/mask=/);
  });

  it('keeps the traced stencil inside its own viewBox', () => {
    // The trace is a grid of rectangles derived from a raster, and an off-by-one in the
    // centring pushes coordinates past 64. SVG clips silently, so the result would be a
    // pinned tab showing only the top of the mark with nothing reporting a problem.
    const d = source('public/safari-pinned-tab.svg').match(/<path d="([^"]+)"/)?.[1] ?? '';
    expect(d.length).toBeGreaterThan(0);
    const numbers = [...d.matchAll(/-?\d+\.?\d*/g)].map((m) => Number(m[0]));
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(64);
    }
  });

  it('advertises no maskable icon, because the artwork cannot survive one', () => {
    // The mark is a floating shape with no full-bleed background. Android crops a
    // maskable icon to a circle, which would cut into the glyph. Claiming one anyway
    // makes Chrome prefer it on install and clip the mark.
    expect(existsSync(resolve('public/icon-512-maskable.png'))).toBe(false);
  });

  it('derives every raster from Logo.jpg rather than by hand', () => {
    // The point of generating is that the set cannot drift. Someone who replaces a file
    // directly has it overwritten on the next run of the script, so the script and its
    // source are part of the contract rather than a convenience.
    const script = source('scripts/build-logo.py');
    expect(script).toContain("ROOT / 'Logo.jpg'");
    for (const name of TRANSPARENT) {
      expect(script, `${name} is not generated by the script`).toContain(name);
    }
    expect(existsSync(resolve('Logo.jpg'))).toBe(true);
  });
});

describe('the mark in the page', () => {
  const header = source('src/components/SiteHeader.astro');
  const views = source('src/routes/views.ts');
  const css = source('public/site.css');
  const admin = source('public/admin.css');

  it('inverts for dark surfaces instead of relying on a filter', () => {
    // The mark is a near-black silhouette, so on the dark ground it is not low contrast,
    // it is absent. Two rasters rather than a CSS filter, because a filter inverts the
    // gold through the complement to teal — which on this palette is the accent colour,
    // so the star would read as interface instead of artwork. The chroma check is what
    // proves the star survived the recolour rather than being flattened to grey.
    const ink = decodePng('logo-mark.png');
    const inverse = decodePng('logo-mark-inverse.png');
    expect([inverse.width, inverse.height]).toEqual([ink.width, ink.height]);
    expect(meanLuminance(inverse) - meanLuminance(ink), 'the inverse is not lighter').toBeGreaterThan(80);
    for (const name of ['logo-mark.png', 'logo-mark-inverse.png']) {
      expect(maxChroma(decodePng(name)), `${name} has no chromatic pixel — the gold star is gone`).toBeGreaterThan(40);
    }
  });

  it('renders the artwork instead of a letter, on both surfaces', () => {
    for (const file of [header, views]) {
      expect(file, 'the ink mark is missing').toContain('/logo-mark.png');
      expect(file, 'the inverse mark is missing').toContain('/logo-mark-inverse.png');
    }
    expect(header).not.toContain('>X</span>');
  });

  it('reserves the mark its true size, so the header does not shift', () => {
    // Sized by the canvas the PNG actually has, not by the mark's extent inside it.
    // Reserving a narrower box than the browser will reserve is what turns a logo into a
    // visible jump on every load that races.
    const flat = header.replace(/\s+/g, ' ');
    for (const name of ['logo-mark.png', 'logo-mark-inverse.png']) {
      const img = decodePng(name);
      expect(flat, `${name}'s dimensions are not reserved`).toContain(
        `src="/${name}" width="${img.width}" height="${img.height}"`,
      );
    }
  });

  it('treats the mark as decorative, because the site name follows it as text', () => {
    // `alt=""` on purpose. The link announces as the site name; an alt repeating it would
    // read "X Article Hub, X Article Hub" on every page.
    for (const file of [header, views]) {
      const imgs = file.match(/<img class="(?:logo|brand)-mark[^>]*>/g) ?? [];
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) expect(img, `missing alt="": ${img}`).toContain('alt=""');
    }
    expect(header).toContain('class="logo-text"');
  });

  it('shows one mark or the other, never both and never neither', () => {
    for (const [name, file] of [
      ['site.css', css],
      ['admin.css', admin],
    ] as const) {
      // The ungated default is the ink mark; the swap has to be `block` for the inverse,
      // because anything else leaves an empty box in the flex row.
      expect(file, `${name} does not hide the inverse by default`).toMatch(
        /\.(?:logo|brand)-mark-inverse\s*\{\s*display:\s*none/,
      );
      expect(file, `${name} does not show the inverse on dark`).toMatch(
        /\.(?:logo|brand)-mark-inverse\s*\{\s*display:\s*block/,
      );
      expect(file, `${name} does not hide the ink mark on dark`).toMatch(
        /\.(?:logo|brand)-mark\s*\{\s*display:\s*none/,
      );
    }
  });

  it('keeps the mark its own shape rather than stretching it into a square', () => {
    // The mark is 809x887, taller than it is wide. Sized by height with the width
    // following the element's own aspect ratio; a square box would squash it into a
    // different logo.
    for (const file of [css, admin]) {
      expect(file).toMatch(/\.(?:logo|brand)-mark\s*\{[^}]*height:\s*\d+px/);
      expect(file).toMatch(/\.(?:logo|brand)-mark\s*\{[^}]*width:\s*auto/);
    }
  });

  it('keeps the no-JS case on the system scheme, and an explicit light choice on light', () => {
    // `data-theme` is written by the inline script, so without scripting it never exists
    // and the media query is the only signal. `:not([data-theme='light'])` keeps a reader
    // who chose light on a dark-mode machine from being overridden.
    //
    // /admin used to be the exception, with an assertion that it contained no
    // `[data-theme` at all — correct while the admin had no switcher, and the reason is
    // now the opposite of true. It has the same control, so it needs the same escape, and
    // the mark matters twice over here: it is a near-black silhouette, so on the dark
    // ground it is not low contrast, it is absent.
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\) \.logo-mark/,
    );
    expect(css).toContain(":root[data-theme='dark'] .logo-mark-inverse");
    expect(admin).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\) \.brand-mark\s*\{\s*display:\s*none/,
    );
    // One rule serves all three states on the admin: no attribute means the media query
    // governs, `dark` matches `:not()`, `light` matches neither. Asserted as a selector
    // rather than as a word, because the reason is written in the comment above it and a
    // plain substring search fails on the explanation of the thing it is checking.
    expect(admin).toContain(":root:not([data-theme='light']) .brand-mark-inverse");
    expect(admin).not.toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.brand-mark/);
  });

  it('leaves no dead token behind for the mark', () => {
    // The tile it used to be drawn as took two tokens. They were declared, not used,
    // which reads as live and gets restyled by whoever finds them next.
    for (const file of [css, admin]) {
      expect(file).not.toContain('--logo-bg');
      expect(file).not.toContain('--logo-ink');
      expect(file).not.toContain('var(--logo-');
    }
  });
});