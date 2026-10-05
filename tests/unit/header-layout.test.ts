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
 * navigation before the site name, the site name before the search box, the search box
 * before the nav glyphs.
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
    // the row has from 1200px up, so the last item was clipped on every desktop. Asserted
    // as an exact value because "roughly 10px" is how it drifted to 11 in the first place.
    expect(css).toMatch(/\.nav-item \{[^}]*padding: 6px 10px;/);
    expect(css).not.toMatch(/\.nav-item \{[^}]*padding: 6px 11px;/);
  });

  it('gives things up in the order the row is worth more', () => {
    // Ascending thresholds mean ascending sacrifice. Primary navigation is never on the
    // list — losing a nav item to a silent horizontal scroll loses the site, whereas the
    // site name is carried by the mark and the document title and the search box is a
    // shortcut to a page the nav links to directly.
    const siteName = hidesAt('.logo-text');
    const searchBox = hidesAt('.search-mini');
    const glyphs = hidesAt('.nav-icon');

    expect(siteName).toBeGreaterThan(searchBox);
    expect(searchBox).toBeGreaterThan(glyphs);
    // And the glyphs are the last thing to go, because a nav that is labels-only still
    // reads; a nav whose labels are clipped does not.
    expect(glyphs).toBeGreaterThan(700);
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
    // The threshold that gives the search box up is 1100px, so a 1280px laptop and a
    // 1440px desktop keep it. Worth asserting because the alternative — hiding it earlier
    // to make the numbers comfortable — is the change that would have cost a feature
    // rather than a few pixels of padding.
    expect(hidesAt('.search-mini')).toBeGreaterThan(1024);
    // …and the site name survives even that.
    expect(hidesAt('.logo-text')).toBeGreaterThan(1100);
  });

  it('gives up exactly as much as the measurements call for', () => {
    // The three thresholds, asserted outright. The test above pins the order and would
    // happily accept a site name hidden from 1300px, which costs a laptop its wordmark for
    // nothing — the row already fits at 1200px. So these are the measured values, and a
    // change to any of them means re-running the measurement rather than nudging a number
    // until the suite is green: 1180 is where the row stops fitting seven items with the
    // wordmark, 1100 is where it stops fitting them with the search box, and 900 is where
    // it stops fitting the glyphs.
    expect(hidesAt('.logo-text')).toBe(1180);
    expect(hidesAt('.search-mini')).toBe(1100);
    expect(hidesAt('.nav-icon')).toBe(900);
  });
});