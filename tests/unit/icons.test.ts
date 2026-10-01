import { describe, expect, it } from 'vitest';
import { layout } from '../../src/routes/views';
import { MANIFEST_HREF, SITE_ICONS, THEME_COLOR, iconLinkHtml } from '../../src/config/icons';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('site icons (SPEC §33)', () => {
  it('declares the SVG first, then a raster fallback for engines without SVG', () => {
    expect(SITE_ICONS[0]).toEqual({ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' });
    expect(SITE_ICONS.some((i) => i.rel === 'icon' && i.href === '/favicon.ico')).toBe(true);
    expect(SITE_ICONS.some((i) => i.rel === 'apple-touch-icon')).toBe(true);
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

  it('ships every file the manifest and head advertise', () => {
    const advertised = [
      '/favicon.svg',
      '/favicon.ico',
      '/apple-touch-icon.png',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-512-maskable.png',
      '/safari-pinned-tab.svg',
      '/favicon-maskable.svg',
    ];
    for (const file of advertised) {
      expect(existsSync(resolve('public', file.slice(1))), `${file} is advertised but missing`).toBe(
        true,
      );
    }
  });

  it('keeps the pinned-tab mask a pure alpha stencil', () => {
    // Safari paints the alpha channel with the user's own toolbar colour. Any
    // colour of its own is ignored at best and a solid background renders a
    // pinned tab as a black square, so the file must be black-and-white only,
    // with the artwork knocked out of the disc rather than painted on it.
    const svg = readFileSync(resolve('public/safari-pinned-tab.svg'), 'utf8');
    // Comments explain the rule; assert against the markup only.
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

  it('keeps the maskable and Apple variants full-bleed so no mask exposes transparency', () => {
    // A shape mask crops to whatever the platform uses — a circle on Android, a
    // squircle on iOS. A tile with its own rounded corners and transparent
    // corners shows a dark halo around the icon on those launchers. Both
    // variants therefore square the tile off, and only the glyph moves.
    for (const file of ['public/favicon-maskable.svg', 'public/safari-pinned-tab.svg']) {
      const svg = readFileSync(resolve(file), 'utf8');
      expect(svg).toMatch(/viewBox="0 0 64 64"/);
    }
    // The default mark may round its corners; the maskable one must not, because a
    // platform mask cropping inside the safe zone would otherwise expose
    // transparency at the corners. Asserted as "the tile is not rounded" rather
    // than as a literal rx, so redrawing the mark does not fail this test.
    const def = readFileSync(resolve('public/favicon.svg'), 'utf8');
    const maskable = readFileSync(resolve('public/favicon-maskable.svg'), 'utf8');
    expect(maskable).not.toBe(def);
    expect(maskable).not.toMatch(/<rect[^>]*\brx=/);
    expect(def).toMatch(/<rect[^>]*\brx="13"/);
  });

  it('has a real 180×180 PNG for the Apple touch icon, not a renamed SVG', () => {
    const png = readFileSync(resolve('public/apple-touch-icon.png'));
    // PNG magic number.
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    // No alpha channel, or iOS renders the transparent pixels black. Colour type
    // sits after the 8-byte signature, the 4-byte IHDR length, the 4-byte chunk
    // name, width and height, then the bit depth: 8 + 4 + 4 + 4 + 4 + 1 = 25.
    // 2 is truecolour, 3 is palette — neither carries alpha.
    const colourType = png[25];
    expect([2, 3], 'apple-touch-icon must not carry transparency').toContain(colourType);
  });
});
