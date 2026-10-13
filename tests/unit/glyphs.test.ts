import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ICON_PATHS, ICON_VIEW_BOX } from '../../src/icons/phosphor';
import { THEME_OPTIONS } from '../../src/lib/theme';

/**
 * The UI glyph set — Phosphor, inlined.
 *
 * Separate from `icons.test.ts`, which is about the brand mark: that one asserts
 * properties of *raster files* the browser fetches, this one asserts properties of
 * *markup* the browser parses. Merging them would mean one file with two unrelated
 * failure modes and a shared helper for neither.
 *
 * What these assertions are actually protecting, each from a way this has gone wrong:
 *
 * - **A name that resolves.** The nav used to carry Unicode glyphs and the theme
 *   switch carried hand-typed path strings, so a typo produced a blank box beside a
 *   perfectly readable label — no error, no failed build. `IconName` makes that a
 *   compile error now; these assertions hold the rest.
 * - **`fill` the CSS cannot override.** The theme switch styled its old stroked icons
 *   with `fill: none`, and a CSS declaration beats an SVG presentation attribute. Had
 *   the paths been swapped in without that rule being removed, all three options would
 *   have rendered as blank squares inside a still-clickable radio group — and no unit
 *   test would have seen it, because the markup is correct and only the cascade
 *   decides.
 * - **One fill model.** `thin` and `light` are the two Phosphor weights drawn with
 *   strokes rather than fills. Mixing one into a set of filled paths renders nothing
 *   under a `fill: currentColor`-only renderer.
 */

const source = (path: string) => readFileSync(resolve(path), 'utf8');

const header = source('src/components/SiteHeader.astro');
const themeSwitch = source('src/components/ThemeSwitch.astro');
const icon = source('src/components/Icon.astro');
const card = source('src/components/ArticleCard.astro');
const css = source('public/site.css');

/** The declaration block for a selector, comments stripped. */
function ruleFor(selector: string): string | undefined {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(clean);
  return match?.[1];
}

/**
 * Every `href` → `icon` pair the header's nav array declares.
 *
 * The label alternation is defensive and came from a real failure. The nav entry was
 * first added as "Editor's Pick", whose apostrophe forces double quotes, and this scanner
 * only matched single quotes — so it silently skipped the entry and reported its glyph as
 * `vendored but unused` rather than failing. The label is now `Featured` and every entry
 * is single-quoted again, but a scanner that quietly stops matching is worse than one that
 * fails, so the alternation stays.
 */
function navIcons(): Array<{ href: string; label: string; icon: string }> {
  return [
    ...header.matchAll(
      // `key` is optional and trailing: the entry gained an i18n key when the interface
      // became multilingual (SPEC §17.4), and a scanner that broke on a new field would
      // report every nav glyph as orphaned rather than failing where the change was.
      /\{ href: '([^']+)', label: (?:'([^']*)'|"([^"]*)"), icon: '([^']+)'(?:, key: '[^']*')? \}/g,
    ),
  ].map((m) => ({
    href: m[1] ?? '',
    label: m[2] ?? m[3] ?? '',
    icon: m[4] ?? '',
  }));
}

/**
 * The glyph names the article card's engagement row passes to `add(…)`.
 *
 * The card is the third place icons are chosen — the nav's come from a literal array, the
 * theme switch's from `THEME_OPTIONS`, and these from a list of counters built at render
 * time. Each new surface is another way for a name to be used without being vendored, so
 * each has to be read from where it actually lives rather than assumed.
 *
 * `add` takes the icon first; the two arguments after it are the value and the title, so
 * anchoring on the call rather than on a bare string keeps a title that happens to be an
 * icon name from being counted twice.
 */
function cardIcons(): string[] {
  return [...card.matchAll(/\badd\(\s*'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('the glyph set', () => {
  it('holds every icon the interface names, and nothing orphaned', () => {
    // The theme switch's glyphs come from `THEME_OPTIONS` at runtime, not from a
    // literal in `ThemeSwitch.astro` — they moved into lib/theme.ts so the admin's copy
    // of the control is generated from the same list. Reading them out of the component's
    // source reported sun, moon and desktop as vendored-but-unused, which is the
    // regression this assertion exists to catch, pointed the other way: the icons are
    // used, the scan had simply stopped looking where they live.
    const used = new Set([
      ...navIcons().map((item) => item.icon),
      ...THEME_OPTIONS.map((option) => option.icon),
      ...cardIcons(),
    ]);
    for (const name of used) {
      expect(name in ICON_PATHS, `"${name}" is used but not vendored`).toBe(true);
    }
    // An icon nobody renders is dead weight in the bundle and in the reader's head,
    // and it is the residue of an earlier choice that nobody wrote down.
    const orphans = Object.keys(ICON_PATHS).filter((name) => !used.has(name));
    expect(orphans, `vendored but unused: ${orphans.join(', ')}`).toEqual([]);
  });

  it('gives every nav destination an icon, and every icon a destination', () => {
    // Home, three score boards, the editor's picks, and the author index. `/search` and
    // `/about` left the nav — neither page left the site — so this is six entries.
    //
    // Pinning the exact list is the point, not incidental: a board added later without an
    // icon is the failure this catches, and so is an entry whose icon was renamed out of
    // the set, which is a build error now that the array is typed `IconName` and a silent
    // blank box before that. The list is also what proves those two pages are still
    // reachable rather than merely unlinked, since `icons.test.ts` fails on a vendored
    // glyph with no destination and `phosphor.ts` has no `magnifying-glass` or `info` left.
    const items = navIcons();
    expect(items.map((i) => i.href)).toEqual([
      '/',
      '/featured',
      '/latest',
      '/trending',
      '/authors',
    ]);
    for (const item of items) {
      expect(item.icon, `${item.href} has no icon`).toBeTruthy();
      expect(item.label, `${item.href} has no label to fall back on`).toBeTruthy();
    }
  });

  it('keeps /search and /about reachable now that they are out of the nav', () => {
    // The nav is not the only thing that links a page. Removing Search and About from it
    // is a change to the navigation, not to the site, and the difference is invisible
    // until something links them nowhere: a search page nobody can find, and an About
    // page describing how the archive works that no reader will ever read.
    //
    // Both are pinned to where they are actually reachable — the footer and the header's
    // search box — so a future edit that drops those links fails here rather than
    // quietly orphaning a page.
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    // The search box submits here. Its own visibility is a layout decision
    // (`.search-mini` hides below 1100px), which is a separate concern from whether the
    // destination is linked at all. The form no longer carries the `search-mini` class —
    // that moved to the wrapper that also holds the category filter — so the assertion is
    // on the action.
    expect(header).toMatch(/<form action="\/search"/);
    // About is in the footer, which is on every page.
      // About is in the footer, which is on every page. The link carries i18n attributes
      // now (SPEC §17.4), so the assertion is on the href and the English text rather than
      // on the exact tag — those attributes are what the language switcher reads.
      expect(header).toMatch(/<a href="\/about"[^>]*>About<\/a>/);
  });

  it('gives each board a distinct glyph, since they order by different things', () => {
    // `/latest` is `published_at DESC` — a question of when. `/trending` is the weighted
    // blend — a question of how much. `/featured` is a human flag and not a score at all.
    // One shared icon would erase that from the navigation, which is the one place a reader
    // looks to find out which board they are on.
    const icons = navIcons().map((i) => i.icon);
    expect(new Set(icons).size, 'two boards share a glyph').toBe(icons.length);
  });

  it('no longer vendors the Rising glyph', () => {
    // `trend-up` had one destination and it was `/rising`; both are gone. A vendored glyph
    // with nowhere to go is what `icons.test.ts` fails on, so leaving it would have meant
    // weakening a rule that exists for a reason.
    expect(Object.keys(ICON_PATHS)).not.toContain('trend-up');
    expect(navIcons().map((i) => i.href)).not.toContain('/rising');
  });

  it('carries only filled single paths on the shared grid', () => {
    // The renderer's whole contract: one `<path>`, no strokes, colour inherited. A
    // stroked icon — `thin` or `light` are the two such weights — draws nothing under
    // a fill-only renderer, and no unit test would notice because the markup is valid.
    expect(ICON_VIEW_BOX).toBe('0 0 256 256');
    for (const [name, d] of Object.entries(ICON_PATHS)) {
      expect(d, `${name} is empty`).toBeTruthy();
      expect(d.length, `${name} is too short to be a glyph`).toBeGreaterThan(100);
      expect(/^[Mm]/.test(d), `${name} does not start with a moveto`).toBe(true);
      // No stroke commands. `S` and `s` are smooth curves, so the letter alone is not
      // enough — a stroke would appear as a presentation attribute, and this module
      // has none by construction.
      expect(/stroke/i.test(d as string), `${name} mentions a stroke`).toBe(false);
      // Only path geometry: no embedded markup, no url(), nothing that could escape the
      // attribute it lands in.
      expect(/[<>"'&]/.test(d as string), `${name} contains markup`).toBe(false);
    }
  });

  it('renders through one component, so the contract cannot drift per call site', () => {
    // Six nav items and three theme options, two hand-written SVG blocks before. Every
    // one of them had to remember `viewBox`, `fill` and `aria-hidden` separately, and
    // the theme switch's did not even share a grid with the nav's.
    expect(icon).toContain('viewBox={ICON_VIEW_BOX}');
    expect(icon).toContain('fill="currentColor"');
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).toContain('focusable="false"');
    // No raw <svg> left outside the component: the whole point is one place that owns
    // the attributes.
    for (const [name, file] of [
      ['SiteHeader.astro', header],
      ['ThemeSwitch.astro', themeSwitch],
    ] as const) {
      expect(file, `${name} still writes its own <svg>`).not.toContain('<svg');
      expect(file, `${name} does not use the shared component`).toContain("<Icon name=");
    }
  });

  it('sizes the box in the markup, so nothing jumps before the stylesheet lands', () => {
    // An SVG with no width and height defaults to 300×150. That is a header that
    // reflows a fraction of a second after paint, and it happens on the first thing
    // above the fold on every page.
    expect(icon).toContain('width={size}');
    expect(icon).toContain('height={size}');
    expect(icon).toMatch(/size\s*=\s*16/);
    // And the call sites differ on purpose: the nav's labels are 14px, the segmented
    // control's box is fixed.
    expect(header).toContain('size={18}');
    expect(themeSwitch).toContain('size={15}');
    // The stylesheet must not then set the size a second time, or the two sources
    // disagree and the markup attributes become decorative.
    for (const selector of ['.nav-icon', '.theme-switch__icon']) {
      const rule = ruleFor(selector) ?? '';
      expect(rule, `${selector} also sets a size`).not.toMatch(/\b(width|height)\s*:/);
    }
  });

  it('leaves no stylesheet rule able to hide a filled glyph', () => {
    // The trap this whole file is built around. `fill: none` here renders all three
    // theme options blank, and it is invisible to every other check because the markup
    // is correct — only the cascade decides.
    for (const selector of ['.nav-icon', '.theme-switch__icon']) {
      const rule = ruleFor(selector) ?? '';
      expect(rule, `${selector} sets fill`).not.toMatch(/\bfill\s*:/);
      expect(rule, `${selector} sets stroke`).not.toMatch(/\bstroke/);
    }
    // And nothing anywhere paints the icons a fixed colour: they inherit, which is what
    // makes them follow the theme and the active state with no second rule.
    const paint = /(?:fill|stroke)\s*:\s*(?!none|currentColor)[^;}]+/g;
    for (const match of css.matchAll(paint)) {
      expect(match[0], `a stylesheet paints an icon: ${match[0]}`).not.toMatch(/#|rgb|hsl/);
    }
  });

  it('stops the glyphs shrinking before their labels do', () => {
    // The nav is `overflow-x: auto` so it can scroll on a narrow screen, and a flex
    // item defaults to shrinking. Without this the six icons deform and no label moves.
    expect(ruleFor('.nav-icon'), '.nav-icon is not styled').toMatch(/flex:\s*none/);
    // `pointer-events: none` on the theme glyphs is the same idea: the input covers the
    // whole label, so the icon on top of it would otherwise narrow the hit area.
    expect(ruleFor('.theme-switch__icon')).toMatch(/pointer-events:\s*none/);
  });

  it('keeps the icons out of the prose leading, where text rules belong', () => {
    // They are not text any more. Leaving them in the 1.5 fallback list is harmless —
    // an SVG has no line box — and wrong, because the list is a list of things that are
    // text, and it grows stale there.
    const fallback = /\.hero-sub,[\s\S]*?line-height:\s*1\.5;/.exec(css);
    expect(fallback, 'cannot locate the prose-leading fallback list').not.toBeNull();
    for (const selector of ['.nav-icon', '.logo-mark']) {
      expect(fallback?.[0], `${selector} is still in the prose-leading list`).not.toContain(selector);
    }
  });

  it('leaves no Unicode glyph standing in for an icon', () => {
    // What the navigation used to be: ◆ ↓ 🔥 📈 ⌕ i. Two of those are colour emoji, so
    // they rendered in the platform's emoji font at a different optical size from every
    // other item in the row, and one of them — the flame — is a different illustration
    // style from the rest of the header entirely.
    const glyphs = header.match(/icon:\s*'([^']+)'/g) ?? [];
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph, `a literal glyph is still in the nav: ${glyph}`).toMatch(/icon:\s*'[a-z][a-z-]*'/);
      expect(glyph, `a literal glyph is still in the nav: ${glyph}`).not.toMatch(/[^\x00-\x7F]/);
    }
    // And nothing anywhere in the header falls back to a text symbol either.
    for (const [name, file] of [
      ['SiteHeader.astro', header],
      ['ThemeSwitch.astro', themeSwitch],
    ] as const) {
      expect(file, `${name} still has a hand-written path`).not.toMatch(/d="M[\d.]/);
      expect(file, `${name} still uses a 24-grid`).not.toContain('0 0 24 24');
    }
  });

  it('gives the card a distinct glyph per counter, so the row is not five identical marks', () => {
    // The card's engagement row names five icons. If two were the same — or if the list were
    // satisfied by a single icon reused — the row would read as an unlabelled repeat, and the
    // widened `used` scan in the test above would still pass, because a name used once is
    // used.
    const icons = cardIcons();
    expect(icons.length, 'the card declares no counter icons').toBeGreaterThan(0);
    expect(new Set(icons).size, 'two counters share a glyph').toBe(icons.length);
    // And each is actually rendered, not merely named.
    expect(card).toContain('<Icon name={m.icon}');
  });

  it('reaches the boards too, where an emoji has quietly survived', () => {
    // The nav's emoji were removed and the rule written down; the homepage's two board
    // headings kept theirs — `🔥 Trending` and `🕐 Latest` — because nothing scanned for a
    // glyph outside the header. A rule enforced on one file is a rule with a hole in it, and
    // these are on the first screen of the site, in a row of 12px uppercase labels where a
    // colour emoji is more conspicuous than it ever was in the nav.
    //
    // Asserted against every `.astro` page rather than against index.astro, so the next board
    // added with a `🔥`-style heading fails here instead of shipping. The arrows and the
    // save star are excluded deliberately — those are typographic characters that *are* the
    // label (`← Newer`), not illustrations standing in for a word, and the icons module has no
    // glyph for "back" or "saved" that would be an improvement.
    const allowed = new Set(['←', '→', '↗', '★', '☆', '·', '—', '–', '…']);
    const offenders: string[] = [];
    for (const path of ['src/pages/index.astro', 'src/pages/BoardPage.astro', 'src/components/BoardPage.astro']) {
      let text: string;
      try {
        text = source(path);
      } catch {
        continue;
      }
      // Strip comments: several files quote a spec sentence in Chinese, and the spec's own
      // prose is not a glyph standing in for an icon.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const ch of code) {
        if (ch.charCodeAt(0) > 0x2100 && !allowed.has(ch)) offenders.push(`${path}: ${ch}`);
      }
    }
    expect(offenders, `a glyph is standing in for an icon: ${offenders.join(', ')}`).toEqual([]);
  });

  it('records where the geometry came from', () => {
    // Vendored paths are the kind of thing that gets "tidied" by someone who assumes it
    // was drawn in-house. The provenance and the licence have to be in the file that
    // carries the data, not in a commit message.
    const phosphor = source('src/icons/phosphor.ts');
    expect(phosphor).toContain('phosphoricons.com');
    expect(phosphor).toMatch(/2\.1\.1/);
    expect(phosphor).toMatch(/MIT/);
    expect(source('NOTICE.md')).toMatch(/Phosphor[\s\S]*MIT/);
  });
});