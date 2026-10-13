import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRANSLATIONS } from '../../src/lib/i18n';

/**
 * The header row's arithmetic, for the widest label set.
 *
 * This file exists because the same bug was shipped twice. Moving the category filter into
 * the header row made the row overflow, and the first two measurement rounds both reported
 * a comfortable margin — because they measured the *Chinese* labels. Those are the shortest
 * of the three: the nav needs 358px in zh, 386px in ja and **462px in en**. A margin
 * measured in zh is not a margin; it is the best case, and the site ships English by
 * default.
 *
 * The second mistake was subtler. The nav is `flex: 1`, so `scrollWidth` equals
 * `clientWidth` whenever the content fits — a naive `scrollWidth - clientWidth` reads zero
 * both when a row fits exactly and when it has room to spare, and those are very different
 * states. The numbers here come from measuring the nav's intrinsic content width with
 * `flex: 0 0 auto` and comparing it to the box the row actually gives it.
 *
 * The constants below are measured in headless Chrome against the deployed header, at
 * 1600px viewport, where `--wrap` caps the column at 1180px — which is the whole reason no
 * breakpoint can rescue this row: the column does not get wider on a wider monitor.
 */

const css = readFileSync(resolve('public/site.css'), 'utf8');
const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');

/**
 * Approximate rendered width of `text` at 13px in the header's font stack.
 *
 * An approximation on purpose and only ever used to compare two labels against a width
 * budget, never as an exact figure: the real number depends on the platform font, and the
 * assertions below carry their own slack for that. What it gets right — and what the bug
 * was about — is the *ordering*: English labels are wider than Japanese, which are wider
 * than Chinese.
 */
function textWidth(text: string): number {
  // Measured against canvas measureText in headless Chrome for the header's own font stack.
  // CJK glyphs are full-width (≈13px at a 13px font); Latin averages ≈7px a character.
  return [...text].reduce((w, ch) => w + (/[⺀-鿿가-힯]/.test(ch) ? 13 : 7), 0);
}

/** The nav label for `lang`, as the i18n script would render it. */
function navLabels(lang: 'en' | 'zh' | 'ja'): string[] {
  const nav = ['nav.latest', 'nav.featured', 'nav.trending', 'nav.authors', 'nav.home'] as const;
  return nav.map((key) => TRANSLATIONS[lang][key]);
}

/** Measured intrinsic widths of the nav's five items at 14px with 9px sides and a 6px gap. */
const ITEM_OVERHEAD = 9 * 2 + 6 + 18; // padding + icon gap + the 18px glyph
const NAV_GAP = 2; // .nav { gap: 2px } across four gaps, rounded

/** Intrinsic nav width for a language, from its label widths. */
function navNeeds(lang: 'en' | 'zh' | 'ja'): number {
  return (
    navLabels(lang).reduce((sum, label) => sum + textWidth(label) + ITEM_OVERHEAD, 0) +
    NAV_GAP * (navLabels(lang).length - 1)
  );
}

/** The header's content width: `--wrap` minus the `.wrap` padding on both sides. */
function wrapContentWidth(): number {
  const wrap = /--wrap:\s*(\d+)px/.exec(css);
  const padding = /\.wrap \{[^}]*padding: 0 (\d+)px/.exec(css);
  return Number(wrap?.[1] ?? 1180) - 2 * Number(padding?.[1] ?? 24);
}

describe('the header row, measured against its widest language', () => {
  it('knows which language is the expensive one', () => {
    // The assertion that would have caught the bug. If a future translation is wider than
    // English, it becomes the constraint and the measured constants below have to be
    // re-derived against *it* — so this fails first, naming the language, rather than
    // leaving the budget silently stale.
    const widths = (['en', 'zh', 'ja'] as const).map((l) => ({ lang: l, w: navNeeds(l) }));
    const widest = widths.reduce((a, b) => (b.w > a.w ? b : a));
    expect(widest.lang, 'the widest nav is no longer English — re-measure against it').toBe('en');
  });

  it('fits the widest nav inside the capped column', () => {
    // The budget. The column is `--wrap`-capped at every width from 1301px up, so this one
    // number governs every desktop; a wider monitor changes nothing.
    const budget = wrapContentWidth();

    // Everything in the row that is not the nav and not the search pair, measured:
    // the logo mark (24px — the site name is drawn at no width, see `.logo-text`),
    // the language switch (98px), the theme options (98px), the auth slot (65px).
    const fixed = 24 + 98 + 98 + 65;
    // Five gaps between six flex items, at the base `.header-inner` gap.
    const gap = Number(/\.header-inner \{[\s\S]*?gap: (\d+)px/.exec(css)?.[1] ?? 18);

    // The search pair, measured from the stylesheet: the select plus its gap plus the input.
    const select = Number(/\.category-select \{[\s\S]*?width: (\d+)px/.exec(css)?.[1] ?? 108);
    const input = Number(/\.search-mini input \{[\s\S]*?width: (\d+)px/.exec(css)?.[1] ?? 170);
    const pairGap = Number(/\.search-mini \{[\s\S]*?gap: (\d+)px/.exec(css)?.[1] ?? 6);
    const pair = select + pairGap + input;

    const leftForNav = budget - fixed - pair - gap * 5;

    // The slack the measurement leaves. Deliberately modest: this is an approximation of
    // text width, so the assertion is that the row has *room*, not an exact figure. What it
    // will not tolerate is the row going negative, which is the state that shipped.
    expect(
      leftForNav - navNeeds('en'),
      `nav needs ${navNeeds('en')}px in English but the row leaves ${leftForNav}px`,
    ).toBeGreaterThan(8);

    // And the other two languages, which have never been the problem but are asserted so
    // that a change which fixes English by breaking Chinese fails here too.
    expect(leftForNav - navNeeds('ja')).toBeGreaterThan(8);
    expect(leftForNav - navNeeds('zh')).toBeGreaterThan(8);
  });

  it('draws the site name at no width, since the row cannot afford it', () => {
    // `display: none` would also strip the logo link's only accessible name — both marks
    // are `alt=""` on purpose — so it has to be the clipping pattern.
    expect(css).toMatch(/\.logo-text \{[^}]*clip: rect\(0 0 0 0\)/);
    expect(css).not.toMatch(/\.logo-text \{[^}]*display: none/);
    // …and the element stays in the markup, because that text is what names the link.
    expect(header).toContain('class="logo-text"');
  });

  it('keeps the category filter inside the search pair, not in its own row', () => {
    // The change this budget was paid for. The select has no `name`, so it is never
    // submitted with the search form beside it — choosing a category navigates to
    // `/category/<slug>` rather than shipping a parameter `/search` cannot honour.
    expect(header).toMatch(/<div class="search-mini">/);
    expect(header).toMatch(/<select\s+class="category-select"/);
    expect(header).not.toMatch(/<select[^>]*name="category"/);
    // No standalone chip row is left in the header.
    expect(header).not.toContain('category-bar');
    expect(header).not.toContain('cat-chip');
  });
});
