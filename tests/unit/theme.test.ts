import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { THEME_BODY_SCRIPT, THEME_COOKIE, THEME_HEAD_SCRIPT, THEME_OPTIONS } from '../../src/lib/theme';

const css = readFileSync(resolve('public/site.css'), 'utf8');
const base = readFileSync(resolve('src/layouts/Base.astro'), 'utf8');
const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
const switcher = readFileSync(resolve('src/components/ThemeSwitch.astro'), 'utf8');
/**
 * The two inline scripts and the option list, shared by the public layout and the admin.
 *
 * Assertions about the scripts' *logic* read this file, not `base`, because that is where
 * the logic now lives. Assertions about *where it runs* still read `base`, because that is
 * still where the injection is — and the injection is half the contract: a correct script
 * in a `<script>` tag after `</head>` would flash white before applying, which is the bug
 * the head script exists to prevent.
 */
const shared = readFileSync(resolve('src/lib/theme.ts'), 'utf8');
const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');

/**
 * A source file with its comments removed.
 *
 * Every negative assertion below says "this string must not appear", and more than one
 * of them trips on the comment explaining why. `expect(views).not.toContain('Phase 1')`
 * failed against the doc comment that documents the removal of the Phase 1 label, which
 * is the assertion congratulating itself. Stripping first makes them about the code.
 *
 * `--` goes as well, because the SQL and the CSS-in-strings in these files carry genuine
 * `--` comments.
 */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/**
 * The token block a selector introduces, with comments stripped.
 *
 * `topLevel` matters: the file declares the dark values twice, once under the
 * prefers-color-scheme media query and once under `[data-theme='dark']`. A naive
 * search for `:root {` matches the nested one inside the media query first and
 * silently returns the DARK set for a query about the light default.
 *
 * `sheet` defaults to the public stylesheet so the existing assertions read as before,
 * and the admin's blocks can be asked for by name.
 */
function blockFor(selector: string, topLevel = false, sheet: string = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = topLevel ? `^${escaped}\\s*\\{` : `${escaped}\\s*\\{`;
  const flags = topLevel ? 'm' : 'm';
  const match = new RegExp(`${pattern}([\\s\\S]*?)\\n\\}`, flags).exec(sheet);
  if (!match?.[1]) throw new Error(`no block for ${selector}`);
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `--token` a block declares, so the two themes can be compared. */
function tokensIn(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * Tokens that are theme-invariant, so a mismatch between the two theme blocks is
 * not a defect. `--radius` / `--wrap` / the font stacks are geometry and type that
 * should not move with the scheme.
 *
 * `--logo-bg` and `--logo-ink` used to be here, on the reasoning that a favicon
 * cannot adapt and the in-page mark had to keep matching it. They are gone with the
 * tile they described: the mark is now artwork from `Logo.png` and it *is* themed,
 * because the favicon ships a matching inverse. See the mark assertion at the end.
 */
const THEME_INVARIANT = new Set(['--radius', '--wrap', '--serif', '--sans', '--mono']);

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
    //
    // The script body moved to lib/theme.ts, so what has to be ordered is the injection
    // site in the layout, and `is:inline` is what keeps it synchronous — Astro would
    // otherwise bundle and defer `set:html`, which is the failure this guards.
    const headEnd = base.indexOf('</head>');
    const bodyStart = base.indexOf('<body');
    const inject = base.indexOf('set:html={THEME_HEAD_SCRIPT}');
    expect(inject).toBeGreaterThan(0);
    expect(inject).toBeLessThan(headEnd);
    expect(inject).toBeLessThan(bodyStart);
    expect(base).toMatch(/<script is:inline set:html=\{THEME_HEAD_SCRIPT\}/);
    expect(base).not.toMatch(/<script(?![^>]*is:inline)[^>]*set:html=\{THEME_HEAD_SCRIPT\}/);
    // The body script is the other half: it has to exist, and after the markup it
    // listens on.
    expect(base.indexOf('set:html={THEME_BODY_SCRIPT}')).toBeGreaterThan(bodyStart);
  });

  it('keeps the scripts inline and synchronous, not module or defer', () => {
    // The shared module is a TypeScript file the Worker and Astro both import, which
    // makes it tempting to emit it as a real <script type="module">. That would be
    // strictly worse: module scripts are deferred by definition, so the theme would
    // land after the first paint — the exact flash the inline form prevents.
    for (const script of [THEME_HEAD_SCRIPT, THEME_BODY_SCRIPT]) {
      expect(script).not.toMatch(/type="module"/);
      // Written as plain ES5 in a string, so nothing needs a transpile step to run.
      // Checked on the exported strings rather than on the module, which is itself a
      // TypeScript file full of `const` — a check on the source would be asserting the
      // opposite of what it means.
      //
      // Comments stripped first. `\blet\b` matched the word in a comment ("Attaching this
      // unconditionally would let the OS override an explicit pick"), which is the
      // failure-for-the-wrong-reason shape: the assertion looked like it was policing
      // syntax and was really policing prose. Every comment in these two strings starts
      // at the beginning of a line, which is what makes the strip safe here.
      const code = script
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
      expect(code).not.toMatch(/\bdefer\b/);
      expect(code).not.toMatch(/\bconst\b|\blet\b|=>|\bimport\b/);
      // And the ES5 it does use, so the strip is not what is doing the work.
      expect(code).toMatch(/\bvar\b/);
    }
    expect(THEME_HEAD_SCRIPT).toContain("var VALID = ['light', 'dark', 'system'];");
  });

  it('shares one implementation with the admin rather than copying it', () => {
    // Both surfaces render their own HTML — the public one through Base.astro, the
    // admin through routes/views.ts string templates — and both need the same two
    // scripts. Copying them is the obvious move and the wrong one: the failure this
    // file already recorded, a handler that persisted a choice and repainted nothing,
    // is what a drifted second copy looks like.
    expect(views).toContain('THEME_HEAD_SCRIPT');
    expect(views).toContain('THEME_BODY_SCRIPT');
    expect(views).not.toContain("setAttribute('data-theme'");
    expect(views).not.toContain('localStorage.setItem');
    // And the option list is shared too, so the two controls cannot disagree about
    // what the third option is called or which glyph means it.
    expect(views).toContain('THEME_OPTIONS');
    expect(switcher).toContain('THEME_OPTIONS');
    expect(switcher).not.toMatch(/const OPTIONS: Array<\{ value:/);
  });

  it('persists through both a cookie and localStorage', () => {
    // localStorage is invisible to the server, so without a cookie the switcher
    // would render in the `system` position on every page load even though the
    // theme itself was right — which reads as the control not taking the click.
    //
    // Asserted against the exported strings rather than the module's source, because
    // the storage key and cookie name are interpolated from constants: grepping the
    // file would be asserting on the text `${THEME_STORAGE_KEY}` and would pass
    // whether or not the constant had the right value.
    expect(THEME_BODY_SCRIPT).toContain("localStorage.setItem('xah-theme'");
    expect(THEME_BODY_SCRIPT).toContain('document.cookie');
    expect(THEME_HEAD_SCRIPT).toContain('localStorage.getItem');
    expect(THEME_COOKIE).toBe('xah_theme');
    expect(THEME_HEAD_SCRIPT).toContain(`${THEME_COOKIE}=(light|dark|system)`);
    // Same cookie on both surfaces, scoped to the whole origin, so a choice made while
    // reading is the choice the admin honours without either surface knowing the other
    // exists.
    expect(THEME_BODY_SCRIPT).toContain(`'${THEME_COOKIE}=' + input.value`);
    expect(THEME_BODY_SCRIPT).toContain('path=/');
    expect(header).toContain(THEME_COOKIE);
  });

  it('validates the stored value instead of trusting it', () => {
    // It is client-controlled input reaching a cookie, an attribute and a
    // comparison. Anything outside the three known states must collapse to
    // `system` rather than being written through. `apply()` is the single choke
    // point, so guarding there covers both the stored value and a live change.
    expect(THEME_HEAD_SCRIPT).toContain("var VALID = ['light', 'dark', 'system'];");
    expect(THEME_HEAD_SCRIPT).toMatch(
      /function apply\(choice\) \{\s*if \(VALID\.indexOf\(choice\) === -1\) return;/,
    );
    expect(THEME_HEAD_SCRIPT).toMatch(/apply\(VALID\.indexOf\(stored\) === -1 \? 'system' : stored\)/);
    expect(header).toMatch(/raw === 'light' \|\| raw === 'dark' \|\| raw === 'system'/);
  });

  it('offers exactly three states, each with its own glyph', () => {
    // A three-state control, not a toggle: "follow the system" has to be
    // expressible or a reader whose OS flips at sunset touches the control twice
    // every evening.
    expect(switcher).toMatch(/type="radio"/);
    // The real list, not the source text of it. It used to be counted by matching
    // object literals in `ThemeSwitch.astro`, which broke the moment the entries
    // moved into lib/theme.ts — and would have broken again for the type annotation
    // being a `value: '` of its own, which is how a count of three once became four
    // and the failure pointed at the type instead of at the control.
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual(['light', 'dark', 'system']);
    for (const option of THEME_OPTIONS) {
      expect(option.label.length, `${option.value} has no label`).toBeGreaterThan(0);
      expect(option.icon.length, `${option.value} has no glyph`).toBeGreaterThan(0);
    }
    // Distinct glyphs: two states sharing an icon would leave them indistinguishable
    // in a control whose only other signal is a highlight on a 15px path.
    expect(new Set(THEME_OPTIONS.map((option) => option.icon)).size).toBe(3);
    expect(header).toContain('ThemeSwitch');
  });

  it('falls back to the system scheme when scripting is unavailable', () => {
    // With JS off, data-theme is never written. The media query is what makes the
    // page still respect the OS rather than pinning everyone to light.
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\)/);
  });

  it('adapts the brand mark per theme rather than pinning it', () => {
    // This inverts a decision that used to go the other way, and the reason matters
    // enough to keep asserted. The mark was a dark tile with a light letter, held
    // identical in both themes so it kept matching a favicon that could not adapt —
    // two ways to read one brand depending on where you looked. The favicon now ships
    // its own inverse, so the tab adapts with the page and there is nothing left to
    // hold still; and the mark is a near-black silhouette rather than a tile, so
    // pinned it measures a contrast ratio near 1.1 on #13191c.
    //
    // The tokens that used to carry the tile are gone with it. Asserted as dead, not
    // merely unused: a token left declared reads as live and gets restyled later.
    expect(css).not.toContain('--logo-bg');
    expect(css).not.toContain('--logo-ink');
    expect(DARK).not.toContain('--logo-mark');
    expect(EXPLICIT_LIGHT).not.toContain('--logo-mark');
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
    // The `[data-theme='dark']` and `[data-theme='light']` strips are load-bearing:
    // admin.css declares the palette in three places now, and stripping only `:root`
    // left the dark block's eight literals reported as hard-coded colours.
    const outside = admin
      .replace(/:root\s*\{[\s\S]*?\n\}/g, '')
      .replace(/:root\[data-theme='(dark|light)'\]\s*\{[\s\S]*?\n\}/g, '')
      .replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)];
    expect(literals.map((m) => m[0]), 'hard-coded colour outside the theme tokens').toEqual([]);
  });

  it('lets an explicit choice beat the system scheme', () => {
    // The whole reason the token blocks were restructured. This file followed
    // `prefers-color-scheme` alone, on the reasoning that a person editing content is
    // not browsing and an explicit override would have no control to express it. The
    // control exists now, so without these two selectors a reader who chose light on a
    // dark-mode machine would keep getting the dark palette here while the public site
    // honoured the choice — two surfaces of one product disagreeing about the same
    // cookie.
    expect(admin).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/);
    expect(admin).toMatch(/:root\[data-theme='dark'\]\s*\{/);

    // Filtered through THEME_INVARIANT for the same reason the public blocks are:
    // `--radius` is geometry and belongs to `:root` alone, so an unfiltered comparison
    // reports a token that is *supposed* to be missing from the dark set.
    const light = tokensIn(blockFor(':root', true, admin)).filter((t) => !THEME_INVARIANT.has(t)).sort();
    const dark = tokensIn(blockFor(":root[data-theme='dark']", true, admin))
      .filter((t) => !THEME_INVARIANT.has(t))
      .sort();
    const explicitLight = tokensIn(blockFor(":root[data-theme='light']", true, admin))
      .filter((t) => !THEME_INVARIANT.has(t))
      .sort();
    expect(dark).toEqual(light);
    expect(explicitLight).toEqual(light);

    // Same grounds, opposite ends, so one of the two is wrong if either is.
    const bgOf = (body: string) => /--bg:\s*(#[0-9a-f]{6})/i.exec(body)?.[1] ?? '';
    expect(luminance(bgOf(blockFor(':root', true, admin)))).toBeGreaterThan(200);
    expect(luminance(bgOf(blockFor(":root[data-theme='dark']", true, admin)))).toBeLessThan(60);
  });

  it('swaps the brand mark on the choice, not only on the system scheme', () => {
    // The mark is a near-black silhouette, so on the dark ground it is not low contrast,
    // it is absent. A bare media query would leave it missing for anyone who chose light
    // on a dark machine — the same split as the palette, on the one element that cannot
    // be fixed by a token.
    expect(admin).toMatch(/:root:not\(\[data-theme='light'\]\) \.brand-mark \{ display: none; \}/);
    expect(admin).toMatch(/:root:not\(\[data-theme='light'\]\) \.brand-mark-inverse \{ display: block; \}/);
    // The unscoped defaults are the light appearance and stay that way; what has to be
    // unique is the *swap*. One rule may hide the mark and one may show the inverse, and
    // both are the scoped ones — an unscoped second copy is how the mark would go missing
    // for a reader who chose light.
    //
    // Counted rather than pattern-matched for absence, because the earlier version of
    // this asserted "no unscoped `.brand-mark` rule" and that is false by design: the
    // light defaults are unscoped.
    const hidden = code(admin).match(/\.brand-mark\s*\{[^}]*display:\s*none/g) ?? [];
    const shown = code(admin).match(/\.brand-mark-inverse\s*\{[^}]*display:\s*block/g) ?? [];
    expect(hidden.length, 'exactly one rule may hide the mark').toBe(1);
    expect(shown.length, 'exactly one rule may show the inverse').toBe(1);
  });
});

describe('the admin theme control', () => {
  const admin = readFileSync(resolve('public/admin.css'), 'utf8');

  it('replaces the Phase 1 label rather than sitting beside it', () => {
    // `Phase 1` was a build-milestone marker in the corner of every admin page, which
    // meant nothing to anyone but the author and went stale the moment Phase 2 landed —
    // it was still being served after the crawl job it referred to had replaced it.
    // Asserted as absent, since a label left in place next to the new control is exactly
    // the half-done state this change is meant to remove.
    expect(code(views)).not.toContain('Phase 1');
    expect(code(views)).not.toContain('topbar-meta');
    expect(admin).not.toContain('.topbar-meta');
  });

  it('renders the three states, generated from the shared list', () => {
    expect(views).toContain('themeSwitchHtml()');
    expect(views).toContain('THEME_OPTIONS.map(');
    // Same three values the public control offers, and a fieldset with a legend so the
    // radio group is named for assistive tech.
    expect(views).toContain('<fieldset class="theme-switch">');
    expect(views).toContain('<legend class="visually-hidden">Colour theme</legend>');
    expect(views).toContain('role="radiogroup"');
    expect(views).toContain('aria-label=');
    // The glyphs are inline SVG at the same 15px the public control uses, and they come
    // from the vendored path data rather than being redrawn.
    expect(views).toContain('ICON_PATHS[option.icon]');
    expect(views).toContain('width="15" height="15"');
    expect(views).toContain('fill="currentColor"');
    expect(views).toContain('aria-hidden="true"');
  });

  it('paints from data-theme rather than a second implementation', () => {
    // The control is generated, not hand-written, and the paint is the shared head
    // script. A `data-theme` write anywhere in views.ts would be a second apply path,
    // which is the drift the shared module exists to prevent.
    expect(views).toContain('<script>${THEME_HEAD_SCRIPT}</script>');
    expect(views).toContain('<script>${THEME_BODY_SCRIPT}</script>');
    expect(views).not.toContain("setAttribute('data-theme'");
    expect(views).not.toContain('localStorage');
  });

  it('syncs the control to the painted theme instead of guessing', () => {
    // The admin renders no `checked` attribute — the public pages get it from the cookie
    // through `Astro.cookies`, and threading it through seven view functions and their
    // seven call sites for a first-paint nicety was not worth it. So the control is put
    // where the page already is.
    //
    // It reads `data-theme`, not the cookie. Re-reading the cookie here could reproduce
    // exactly the disagreement it exists to prevent: the page is painted from the
    // attribute, so the attribute is the only authoritative source.
    expect(views).toContain('THEME_CONTROL_SYNC_SCRIPT');
    expect(views).toContain("getAttribute('data-theme')");
    expect(views).toMatch(/if \(choice !== 'light' && choice !== 'dark' && choice !== 'system'\) return;/);
    expect(views).toContain('.checked = true');
    // …and the content attribute as well. The property alone drives the rendering, so a
    // missing attribute is invisible on screen and in every screenshot; what it changes is
    // the serialised DOM, which then differs from the public pages' for no visible reason
    // and cannot be inspected by anything reading the markup.
    expect(views).toContain("setAttribute('checked', 'checked')");
  });

  it('names the radio group visually rather than not at all', () => {
    // `display: none` on the legend would strip the fieldset's accessible name and the
    // control would announce as an unlabelled group. Copied from the public stylesheet,
    // so the two surfaces cannot differ on this.
    expect(admin).toMatch(/\.visually-hidden\s*\{/);
    expect(admin).not.toMatch(/\.visually-hidden\s*\{[^}]*display:\s*none/);
    // The inputs stay in the tab order, which is what makes the control keyboard usable.
    expect(admin).toMatch(/\.theme-switch__option input\s*\{[^}]*opacity:\s*0/);
    expect(admin).not.toMatch(/\.theme-switch__option input\s*\{[^}]*display:\s*none/);
    // Highlighting is CSS, so the control renders and responds before any script runs.
    expect(admin).toMatch(/\.theme-switch__option:has\(input:checked\)/);
    expect(admin).toMatch(/\.theme-switch__option:has\(input:focus-visible\)/);
  });
});

describe('applying a theme change', () => {
  // The shared strings, which is where the logic lives. `base` used to be sliced from
  // its last <script> tag, which now only holds the injection — correct assertions
  // about the handler would have passed on an empty string, or failed for reasons that
  // had nothing to do with the handler.
  const handler = THEME_BODY_SCRIPT;

  it('repaints on change, not just on the next load', () => {
    // The bug this file exists because of. The handler persisted the choice and
    // nothing else, on the assumption that the radio's :checked state plus CSS would
    // repaint the page. It does not: that rule only highlights the control, and the
    // theme is driven by data-theme on <html>, which nothing was writing. Clicking
    // "dark" moved the highlight and left the page light until a reload.
    expect(handler).toContain('window.__xahTheme(input.value)');
    expect(handler).not.toMatch(/localStorage\.setItem\('xah-theme', input\.value\);?\s*\}\);?\s*$/);
    // And the apply call comes before the persistence, not after: a handler that stores
    // first and paints second would still work, but a reader whose storage throws would
    // land in the catch and never reach the paint.
    expect(handler.indexOf('__xahTheme(input.value)')).toBeLessThan(
      handler.indexOf('localStorage.setItem'),
    );
  });

  it('exposes one apply function rather than two implementations', () => {
    // The attribute write, the theme-color tag and the media listener all have to
    // happen. Duplicating that across the head script and the change handler is how
    // they drift, and the drift is what shipped the bug.
    expect(THEME_HEAD_SCRIPT).toContain('window.__xahTheme = apply');
    expect(THEME_HEAD_SCRIPT).toMatch(/function apply\(choice\)/);
    expect(THEME_HEAD_SCRIPT).toContain("root.setAttribute('data-theme', choice)");
    // The change handler calls the shared function rather than writing the attribute.
    expect(handler).not.toContain("setAttribute('data-theme'");
    expect(handler).toContain('__xahTheme');
    // Both surfaces reach the same implementation, which is the whole point of the
    // shared module: one apply function, installed once, by whichever surface loaded.
    expect(views).toContain('THEME_HEAD_SCRIPT');
  });

  it('keeps following the OS in the system state, and stops when overridden', () => {
    // The listener is attached only for `system`. Attaching it unconditionally would
    // let the OS override an explicit pick the moment the machine switched appearance.
    expect(THEME_HEAD_SCRIPT).toMatch(/if \(choice === 'system'\) \{[\s\S]{0,320}addEventListener|addListener/);
    expect(THEME_HEAD_SCRIPT).toContain("if (root.getAttribute('data-theme') !== 'system') return;");
  });
});
