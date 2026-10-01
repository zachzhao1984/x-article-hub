import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('public/site.css'), 'utf8');
const base = readFileSync(resolve('src/layouts/Base.astro'), 'utf8');
const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
const switcher = readFileSync(resolve('src/components/ThemeSwitch.astro'), 'utf8');

/**
 * The token block a selector introduces, with comments stripped.
 *
 * `topLevel` matters: the file declares the dark values twice, once under the
 * prefers-color-scheme media query and once under `[data-theme='dark']`. A naive
 * search for `:root {` matches the nested one inside the media query first and
 * silently returns the DARK set for a query about the light default.
 */
function blockFor(selector: string, topLevel = false): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = topLevel ? `^${escaped}\\s*\\{` : `${escaped}\\s*\\{`;
  const flags = topLevel ? 'm' : 'm';
  const match = new RegExp(`${pattern}([\\s\\S]*?)\\n\\}`, flags).exec(css);
  if (!match?.[1]) throw new Error(`no block for ${selector}`);
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `--token` a block declares, so the two themes can be compared. */
function tokensIn(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * Tokens that describe the mark rather than the surface. `--logo-bg` is
 * deliberately identical in both themes because a favicon cannot adapt, and
 * `--radius` / `--wrap` / the font stacks are theme-invariant, so they belong in
 * :root only. Everything else has to be restated per theme.
 */
const THEME_INVARIANT = new Set([
  '--radius',
  '--wrap',
  '--serif',
  '--sans',
  '--mono',
  '--logo-bg',
  '--logo-ink',
]);

/** `#rrggbb` to 0–255 channels. Off-by-one here silently reads shifted bytes, so
 *  it lives in one place rather than being re-derived per assertion. */
function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  if (value.length < 6) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance, 0 (black) to 255 (white). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('colour themes', () => {
  const LIGHT = blockFor(':root', true);
  const DARK = blockFor(":root[data-theme='dark']", true);
  const EXPLICIT_LIGHT = blockFor(":root[data-theme='light']", true);

  it('declares the same token set in both themes', () => {
    // A token present in one theme and missing from the other silently falls back
    // to the light value, which is how a dark page ends up with a black card on a
    // near-black ground. The set has to match exactly.
    const light = tokensIn(LIGHT).filter((t) => !THEME_INVARIANT.has(t));
    const dark = tokensIn(DARK).filter((t) => !THEME_INVARIANT.has(t));
    expect(dark.slice().sort()).toEqual(light.slice().sort());
  });

  it('resolves an explicit light choice identically to the default', () => {
    // The media query only covers "no preference expressed". On a dark-mode machine
    // a reader who picked light needs `[data-theme='light']` to win, and it has to
    // agree with :root or the choice would half-apply.
    const defaults = tokensIn(LIGHT).filter((t) => !THEME_INVARIANT.has(t));
    const explicit = tokensIn(EXPLICIT_LIGHT).filter((t) => !THEME_INVARIANT.has(t));
    expect(explicit.slice().sort()).toEqual(defaults.slice().sort());

    for (const token of defaults) {
      const fromRoot = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(LIGHT)?.[1]?.trim();
      const fromAttr = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(EXPLICIT_LIGHT)?.[1]?.trim();
      expect(fromAttr, `${token} differs between :root and [data-theme='light']`).toBe(fromRoot);
    }
  });

  it('keeps the dark ground dark and the light ground light', () => {
    // Guards against a typo that makes one theme a recolour of the other's values.
    const bgOf = (body: string) => /--bg:\s*(#[0-9a-f]{6})/i.exec(body)?.[1] ?? '';
    expect(luminance(bgOf(LIGHT))).toBeGreaterThan(200);
    expect(luminance(bgOf(DARK))).toBeLessThan(60);
  });

  it('uses the same accent hue in both themes, at different lightness', () => {
    // A teal that becomes a different colour in the dark theme reads as two brands.
    const hue = (hex: string) => {
      // Normalised to 0–1 for the ratios; the absolute scale does not affect hue.
      const [r = 0, g = 0, b = 0] = channels(hex).map((c) => c / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return Math.round(((h * 60) + 360) % 360);
    };
    const accent = (body: string) => /--accent:\s*(#[0-9a-f]{6})/i.exec(body)?.[1] ?? '';
    // A tolerance, not equality. These two values came from the same reference hue
    // but were each picked for contrast against their own ground, and rounding the
    // channels to what reads on paper and on a near-black ground moves the hue by a
    // couple of degrees. An exact match would be asserting a rounding artefact; what
    // matters is that the brand is recognisably the same colour, not two.
    const delta = Math.abs(hue(accent(LIGHT)) - hue(accent(DARK)));
    expect(delta, `accent hue drifted ${delta}° between themes`).toBeLessThanOrEqual(8);
  });

  it('has no colour hard-coded outside the token blocks', () => {
    // The old stylesheet pinned the header to rgba(11,14,19,.9) and the search
    // highlight to the old blue, which is invisible in the light theme. Anything
    // outside a token block has to survive a palette change, so it cannot be a
    // literal colour.
    const outside = css
      .replace(/:root\s*\{[\s\S]*?\n\}/g, '')
      .replace(/:root\[data-theme='(dark|light)'\]\s*\{[\s\S]*?\n\}/g, '')
      .replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)];
    expect(literals.map((m) => m[0]), 'hard-coded colour outside the theme tokens').toEqual([]);
  });

  it('applies the theme before first paint', () => {
    // A deferred or module script runs after the first paint, which is exactly the
    // flash this exists to prevent: the page would render in the light theme and
    // then jump to dark.
    const headEnd = base.indexOf('</head>');
    const bodyStart = base.indexOf('<body');
    const apply = base.indexOf("setAttribute('data-theme'");
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(headEnd);
    expect(apply).toBeLessThan(bodyStart);
    // Synchronous inline, not type="module" and not defer.
    expect(base).toContain('<script is:inline>');
    expect(base).not.toMatch(/<script[^>]*type="module"[^>]*>[^<]*data-theme/);
  });

  it('persists through both a cookie and localStorage', () => {
    // localStorage is invisible to the server, so without a cookie the switcher
    // would render in the `system` position on every page load even though the
    // theme itself was right — which reads as the control not taking the click.
    expect(base).toContain("localStorage.setItem('xah-theme'");
    expect(base).toContain('document.cookie');
    expect(header).toContain('xah_theme');
  });

  it('validates the stored value instead of trusting it', () => {
    // It is client-controlled input reaching a cookie, an attribute and a
    // comparison. Anything outside the three known states must collapse to
    // `system` rather than being written through.
    expect(base).toContain("stored !== 'light' && stored !== 'dark' && stored !== 'system'");
    expect(header).toMatch(/raw === 'light' \|\| raw === 'dark' \|\| raw === 'system'/);
  });

  it('offers three states, and the current one is server-rendered', () => {
    for (const value of ['light', 'dark', 'system']) {
      expect(switcher).toContain(`value: '${value}'`);
    }
    // A three-state control, not a toggle: "follow the system" has to be
    // expressible or a reader whose OS flips at sunset touches the control twice
    // every evening.
    // The inputs come from a map over OPTIONS, so the source carries one literal
    // rather than three — the count of OPTIONS entries is what matters.
    expect(switcher).toMatch(/type="radio"/);
    for (const value of ['light', 'dark', 'system']) {
      expect(switcher).toMatch(new RegExp(`value: '${value}'`));
    }
    expect((switcher.match(/value: '/g) ?? []).length).toBe(3);
    expect(header).toContain('ThemeSwitch');
  });

  it('falls back to the system scheme when scripting is unavailable', () => {
    // With JS off, data-theme is never written. The media query is what makes the
    // page still respect the OS rather than pinning everyone to light.
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\)/);
  });

  it('keeps the logo tile identical in both themes', () => {
    // A favicon cannot adapt to a colour scheme. The in-page mark inverting with
    // the theme meant the same brand read two different ways depending on where
    // you looked.
    expect(css).toMatch(/--logo-bg:\s*#202a30/);
    expect(css).toMatch(/--logo-ink:\s*#faf9f6/);
    // Declared once, on :root, and not repeated in either theme block.
    expect(DARK).not.toContain('--logo-bg');
    expect(EXPLICIT_LIGHT).not.toContain('--logo-bg');
  });

  it('hides the fieldset label from sight but not from assistive tech', () => {
    // A <legend> is what names the radio group. `display: none` would strip the
    // fieldset's accessible name and the control would announce as an unlabelled
    // group, so the hiding has to be visual only.
    expect(css).toMatch(/\.visually-hidden\s*\{/);
    expect(css).not.toMatch(/\.visually-hidden\s*\{[^}]*display:\s*none/);
    expect(switcher).toContain('visually-hidden');
  });
});

describe('admin palette', () => {
  const admin = readFileSync(resolve('public/admin.css'), 'utf8');

  it('uses the same token names as the public stylesheet', () => {
    // Two surfaces of one product. The admin used to carry GitHub's dark palette,
    // so the only thing they shared was a logo.
    for (const token of ['--bg', '--panel', '--border', '--text', '--muted', '--accent']) {
      expect(admin, `admin.css is missing ${token}`).toContain(token);
    }
    expect(admin).toContain('@media (prefers-color-scheme: dark)');
  });

  it('has no colour hard-coded outside the token blocks', () => {
    const outside = admin
      .replace(/:root\s*\{[\s\S]*?\n\}/g, '')
      .replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)];
    expect(literals.map((m) => m[0]), 'hard-coded colour outside the theme tokens').toEqual([]);
  });
});
