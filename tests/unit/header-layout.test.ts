import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The header row's fit.
 *
 * The nav is `flex: 1` with `overflow-x: auto`, so when the row runs out of room it does
 * not wrap or clip — it scrolls, silently, with no affordance. That makes an overflowing
 * nav item effectively invisible, which is why adding a seventh entry needed measuring
 * rather than eyeballing: the screenshots that decided the label looked fine at 1280px
 * and hid a 9px clip and two missing items at 1100px.
 *
 * Measured in headless Chrome with the deployed markup: the nav needs 642px at 14px/10px
 * padding with all seven items, and the row has 642px at 1200px, 613px at 1151px, 610px at
 * 1024px and 626px at 820px — non-monotonic, because the search box disappearing hands its
 * 190px straight back to the nav.
 *
 * The thresholds below are those measurements. What is asserted here is the *order* they
 * give things up in, which is the part that is a decision rather than a number: primary
 * navigation before the search box, the search box before the nav glyphs. The site name
 * used to be the first entry in that order; it is now drawn at no width at all.
 */

const css = readFileSync(resolve('public/site.css'), 'utf8');

/** The `@media` block containing `selector`, as `max-width` pixels. */
function hidesAt(selector: string): number {
  // Non-greedy to the block's own closing brace: these blocks have no nested braces, and a
  // lazy `[\s\S]*?\n\}` would stop at the first inner rule and read the wrong number.
  const re = new RegExp(`@media \\(max-width: (\\d+)px\\) \\{([\\s\\S]*?)\\n\\}`, 'g');
  for (const match of css.matchAll(re)) {
    if (new RegExp(`(?:^|[\\s,{])${selector.replace('.', '\\.')}\\s*\\{[^}]*display:\\s*none`).test(match[2] ?? '')) {
      return Number(match[1]);
    }
  }
  throw new Error(`no max-width block hides ${selector}`);
}

describe('the header nav', () => {
  it('fits at every width it claims to', () => {
    // The number that started this: 11px sides put seven items at 651px against the 642px
    // the row had from 1200px up, so the last item was clipped on every desktop. Then 10px
    // sides put six items at 558px against 553px — the same fault, 5px instead of 9px, one
    // item later. Asserted as an exact value both times, because "roughly 9px" is how it
    // drifted to 11 in the first place.
    //
    // The 700px block is the third value, and it is a half-pixel because the row is not a
    // round one: 640px leaves 378px for a nav needing 381px at 9px sides. 8px overshoots,
    // 8.5px closes it with room to spare. Measured afterwards: zero scroll at every width
    // from 640 to 1920 in both signed-in and signed-out states.
    expect(css).toMatch(/\.nav-item \{[^}]*padding: 6px 9px;/);
    expect(css).not.toMatch(/\.nav-item \{[^}]*padding: 6px 10px;/);
    expect(css).not.toMatch(/\.nav-item \{[^}]*padding: 6px 11px;/);
    expect(css).toMatch(/\.nav-item \{ padding: 6px 8\.5px; font-size: 13px; \}/);
  });

  it('gives things up in the order the row is worth more', () => {
    // Ascending thresholds mean ascending sacrifice. Primary navigation is never on the
    // list — losing a nav item to a silent horizontal scroll loses the site, whereas the
    // search box is a shortcut to a page the nav links to directly.
    //
    // The site name used to be the first entry here, hiding at 1300px. It is not on the
    // ladder any more because it is now hidden at *every* width: the category filter moved
    // into this row, and the column is `--wrap`-capped at all widths above 1300px, so there
    // is no band where the name fits. See `.logo-text` for the measurement.
    const searchBox = hidesAt('.search-mini');
    const glyphs = hidesAt('.nav-icon');

    expect(searchBox).toBeGreaterThan(glyphs);
    // And the glyphs are the last thing to go, because a nav that is labels-only still
    // reads; a nav whose labels are clipped does not.
    expect(glyphs).toBeGreaterThan(700);
    // The name is hidden by the base rule, not by a breakpoint — `display: none` would
    // also remove the logo link's accessible name, which only this text carries.
    expect(css).toMatch(/\.logo-text \{[^}]*clip: rect\(0 0 0 0\)/);
    expect(css).not.toMatch(/\.logo-text \{[^}]*display: none/);
  });

  it('degrades by scrolling rather than by clipping', () => {
    // Below roughly 600px seven items plus the mark and the theme switch genuinely do not
    // fit, and this is the phone case that scrolled with six items too. What matters is
    // that the failure mode is a scroll the reader can perform, not content that vanishes
    // — so `overflow-x: auto` on the nav is load-bearing and `nowrap` on the items is what
    // keeps them from wrapping into a taller header instead.
    expect(css).toMatch(/\.nav \{[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.nav-item \{[^}]*white-space: nowrap;/);
  });

  it('keeps the search box on a desktop', () => {
    // The threshold that gives the search box up is 1200px, so a 1280px laptop and a
    // 1440px desktop keep it. Worth asserting because the alternative — hiding it earlier
    // to make the numbers comfortable — is the change that would have cost a feature
    // rather than a few pixels of padding.
    expect(hidesAt('.search-mini')).toBeGreaterThan(1024);
    // …and the mark survives even that. It is what still names the site once the wordmark
    // stops being drawn.
    expect(css).toContain('.logo-mark');
  });

  it('gives up exactly as much as the measurements call for', () => {
    // The two remaining thresholds, asserted outright. The test above pins the order and
    // would happily accept the search box being hidden from 1400px, which costs a laptop
    // its search field for nothing. So these are the measured values, and a change to any
    // of them means re-running the measurement rather than nudging a number until the suite
    // is green.
    //
    // Re-measured when the category filter moved into the header row. That is also when the
    // site name left the ladder — it used to be a third entry here, at 1300:
    //
    //   the row gained a ~152px <select>, and the column is --wrap-capped at 1180px of
    //   content at every viewport from 1301px up, so a wider monitor buys nothing. With the
    //   Chinese labels — the widest of the three — the nav needs 372px and the row gave it
    //   288px. Every combination that kept the wordmark (shrinking the search box, the
    //   select, or the header gap) landed within ±10px of that line, which is no margin.
    //
    //   1200  where it stops fitting the search box *and* the filter with it. Was 1100;
    //         the pair is ~350px rather than the box's ~190px, so the band that used to
    //         just fit no longer does.
    //    900  where it stops fitting the glyphs. Unchanged — it absorbed the filter before
    //         this one had to.
    expect(hidesAt('.search-mini')).toBe(1200);
    expect(hidesAt('.nav-icon')).toBe(900);
  });
});