import { describe, expect, it } from 'vitest';
import { layout } from '../../src/routes/views';
import { MANIFEST_HREF, SITE_ICONS, THEME_COLOR, iconLinkHtml } from '../../src/config/icons';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** IHDR is the first chunk: 8-byte signature, 4-byte length, 4-byte name. */
function readPngHeader(file: string): {
  width: number;
  height: number;
  colourType: number;
  opaque: boolean;
} {
  const png = readFileSync(resolve('public', file));
  if ([...png.subarray(0, 4)].join(',') !== '137,80,78,71') {
    throw new Error(`${file} is not a PNG`);
  }
  const colourType = png[25] ?? -1;
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    // 0 grey, 2 truecolour, 3 palette carry no alpha; 4 and 6 do.
    colourType,
    opaque: colourType === 0 || colourType === 2 || colourType === 3,
  };
}

describe('site icons (SPEC §33)', () => {
  it('advertises the hand-tuned small sizes explicitly', () => {
    // Without `sizes` a browser may treat a PNG as scalable and pick the 512 for a
    // 16px tab, which throws away the artwork that was drawn for that size.
    const byHref = new Map(SITE_ICONS.map((i) => [i.href, i]));
    expect(byHref.get('/favicon-16x16.png')).toMatchObject({ rel: 'icon', sizes: '16x16' });
    expect(byHref.get('/favicon-32x32.png')).toMatchObject({ rel: 'icon', sizes: '32x32' });
    expect(byHref.get('/apple-touch-icon.png')).toMatchObject({ rel: 'apple-touch-icon' });
  });

  it('ships no SVG icon, which would silently outrank the raster set', () => {
    // A vector `rel="icon"` takes precedence over every raster alternative. The
    // source artwork has no vector form, so one shipping here would override the
    // favicon.io files and none of the tuning below would reach a browser.
    expect(SITE_ICONS.some((i) => i.href.endsWith('.svg'))).toBe(false);
    expect(existsSync(resolve('public/favicon.svg'))).toBe(false);
  });

  it('puts every icon in the admin head, not just the public pages', () => {
    // Two independent head templates exist. An admin page showing a different
    // favicon than an article page is the drift this guards against.
    const html = layout({ title: 'Articles', active: 'articles', siteName: 'X Article Hub' }, '');
    for (const icon of SITE_ICONS) {
      expect(html).toContain(iconLinkHtml(icon));
    }
    expect(html).toContain(`href="${MANIFEST_HREF}"`);
    expect(html).toContain(`content="${THEME_COLOR}"`);
  });

  it('ships every file the head and the manifest advertise', () => {
    const advertised = [
      '/favicon-16x16.png',
      '/favicon-32x32.png',
      '/favicon.ico',
      '/apple-touch-icon.png',
      '/icon-192.png',
      '/icon-512.png',
      '/safari-pinned-tab.svg',
    ];
    for (const file of advertised) {
      expect(existsSync(resolve('public', file.slice(1))), `${file} is advertised but missing`).toBe(
        true,
      );
    }
  });

  it('has each advertised PNG at the size it claims', () => {
    // A 16x16 `sizes` on a 512px file is a lie the browser will believe.
    expect(readPngHeader('favicon-16x16.png')).toMatchObject({ width: 16, height: 16 });
    expect(readPngHeader('favicon-32x32.png')).toMatchObject({ width: 32, height: 32 });
    expect(readPngHeader('apple-touch-icon.png')).toMatchObject({ width: 180, height: 180 });
    expect(readPngHeader('icon-192.png')).toMatchObject({ width: 192, height: 192 });
    expect(readPngHeader('icon-512.png')).toMatchObject({ width: 512, height: 512 });
  });

  it('has an opaque Apple touch icon, or iOS renders the corners black', () => {
    // iOS applies its own mask and draws transparency as black, so a transparent
    // touch icon ships black corners. The source art is a near-black mark on a light
    // field, and the shipped file bakes that field in.
    const header = readPngHeader('apple-touch-icon.png');
    expect(header.width).toBe(180);
    expect(header.opaque, 'apple-touch-icon must not carry an alpha channel').toBe(true);
  });

  it('keeps a light theme colour, since the mark is near-black', () => {
    // A dark theme colour behind a near-black mark is the icon disappearing into
    // the browser chrome. This is a value assertion, not a format one: any colour
    // that is genuinely light passes, a saturated blue does not.
    const hex = THEME_COLOR.replace('#', '');
    const channels: number[] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(24);
    expect(channels.reduce((sum, c) => sum + c, 0) / 3).toBeGreaterThan(180);
  });

  it('keeps the pinned-tab mask a pure alpha stencil', () => {
    // Safari paints the alpha channel with the user's own toolbar colour. Any
    // colour of its own is ignored at best, and a solid background renders a pinned
    // tab as a black square, so the file must be black-and-white only.
    const svg = readFileSync(resolve('public/safari-pinned-tab.svg'), 'utf8');
    const markup = svg.replace(/<!--[\s\S]*?-->/g, '');
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
    // The trace is a grid of rectangles derived from a 512px raster, and an
    // off-by-one in the centring pushes coordinates past 64. SVG clips silently, so
    // the result is a pinned tab showing only the top of the mark with nothing
    // reporting a problem.
    const svg = readFileSync(resolve('public/safari-pinned-tab.svg'), 'utf8');
    const d = svg.match(/<path d="([^"]+)"/)?.[1] ?? '';
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
    // maskable icon to a circle, which would cut into the glyph. Claiming one
    // anyway makes Chrome prefer it on install and clip the mark.
    expect(existsSync(resolve('public/icon-512-maskable.png'))).toBe(false);
  });
});
