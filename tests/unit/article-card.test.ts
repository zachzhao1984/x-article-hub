import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The article card's uniform height.
 *
 * A feed of cards whose heights differ is a grid that reads as a mistake — the ragged bottom
 * edge is the first thing the eye finds, and it is what this file exists to prevent. Every
 * measurement below came from the deployed page in headless Chrome, and every rule here is
 * one of the ways a card's height stops being determined by text and starts being determined
 * by what is inside it.
 *
 * What each assertion is holding, and the failure it came from:
 *
 * - **The cover is a fixed pixel height.** It was `aspect-ratio`, which gave the same article
 *   two different heights depending on which column it sat in — measured at 205px in the
 *   two-column Trending area against 260px in the wide Editor's Pick grid. A ratio cannot be
 *   uniform across columns; a pixel value can.
 * - **The title is one line with an ellipsis.** Titles in this archive run 25 to 59 characters,
 *   so letting them wrap gave the same row cards of three different heights.
 * - **The meta row has a fixed height.** The Editor's Pick badge is 11px in a 1px border,
 *   which made a row containing it 21px against 18px without — so the badge, a decoration,
 *   decided the card's height.
 * - **The excerpt slot is reserved even when empty.** Only some articles have a summary, so a
 *   feed of mixed ones had two card heights until the empty slot held the space open.
 * - **The footer does not wrap.** `flex-wrap: wrap` pushed the counters onto a second line
 *   when they did not fit, so the engagement row — the most interesting thing on one card —
 *   was also what broke the grid.
 *
 * The one thing deliberately *not* asserted is the exact pixel values; they are tuned against
 * real images and the comment on `.card-cover` in the stylesheet records the measurements. A
 * test that pinned `150px` would fail on the next legitimate tuning and teach nobody anything.
 * What is pinned is the *shape* of each rule: fixed, single-line, non-wrapping.
 */

const css = readFileSync(resolve('public/site.css'), 'utf8');
const card = readFileSync(resolve('src/components/ArticleCard.astro'), 'utf8');

/** The declaration block for a selector, comments stripped. */
function ruleFor(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(clean);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1] ?? '';
}

describe('the article card', () => {
  it('pins the cover to a pixel height, not a ratio', () => {
    const cover = ruleFor('.card-cover');
    expect(cover, 'the cover has no fixed height').toMatch(/\bheight:\s*\d+px/);
    // A ratio is the specific mistake: it resolves differently in a 365px slot than in a
    // 665px one, so the same card is two heights depending on where it is placed.
    expect(cover, 'a ratio makes the height column-dependent').not.toMatch(/aspect-ratio/);
    // And it must not grow when the grid stretches the card to its row's height.
    expect(cover, 'the cover absorbs the row slack').toMatch(/flex:\s*none/);
  });

  it('fills the cover, because a fixed box and an uncropped image cannot both hold', () => {
    // `contain` in a fixed box leaves bars above and below every image whose shape is not the
    // box's — measured at 37px per side on a 1200x480 banner. Bars read as a broken layout;
    // a cropped banner reads as a thumbnail. This is the deliberate reversal, so it is
    // asserted rather than left to drift back.
    expect(ruleFor('.card-cover img')).toMatch(/object-fit:\s*cover/);
  });

  it('gives the placeholder the identical box, so no cover means no size change', () => {
    // The empty state differs by what is inside the slot, not by how much room it takes.
    // A different `aspect-ratio` here once made the card with no image the tallest in its row.
    const empty = ruleFor('.card-cover-empty');
    expect(empty).toMatch(/\bheight:\s*100%/);
    expect(empty, 'the empty slot sizes itself instead of filling the box').not.toMatch(/aspect-ratio/);
  });

  it('keeps the title to one line, ellipsised', () => {
    const title = ruleFor('.card-title');
    // The three declarations that are the whole mechanism. Any one missing and the title
    // wraps to two or three lines, which is the height difference this is about.
    expect(title, 'the title wraps').toMatch(/white-space:\s*nowrap/);
    expect(title, 'the overflow is visible').toMatch(/overflow:\s*hidden/);
    expect(title, 'there is no ellipsis').toMatch(/text-overflow:\s*ellipsis/);
    // `min-width: 0` is the non-obvious one: a flex item defaults to `min-width: auto` and
    // refuses to shrink below its content, so without this the title widens its own column
    // instead of truncating and the ellipsis never appears.
    expect(title, 'the title cannot shrink, so nothing truncates').toMatch(/min-width:\s*0/);
  });

  it('keeps the meta row to a fixed one-line height', () => {
    const meta = ruleFor('.card-meta');
    expect(meta, 'the meta row has no fixed height').toMatch(/\bheight:\s*\d+px/);
    expect(meta, 'the meta row wraps').toMatch(/white-space:\s*nowrap/);
    expect(meta).toMatch(/overflow:\s*hidden/);
    // The badge is what varied it before: 11px in a border is taller than 12px text, so a
    // card with a pick badge was 3px taller than one without.
    expect(meta, 'contents are not centred in the fixed height').toMatch(/align-items:\s*center/);
  });

  it('reserves the excerpt slot whether or not the article has a summary', () => {
    // Only some articles have an excerpt, so a feed of mixed ones had two heights until the
    // card rendered an empty slot of the same size.
    expect(card, 'the card renders no reserved slot').toMatch(/card-excerpt-empty/);
    expect(card, 'the slot is not rendered on the branch without an excerpt').toMatch(
      /article\.excerpt\s*\?[\s\S]*?card-excerpt[\s\S]*?:[\s\S]*?card-excerpt-empty/,
    );
    const empty = ruleFor('.card-excerpt-empty');
    expect(empty, 'the empty slot has no height').toMatch(/\bheight:/);
    // Both used, so neither can quietly become a different size from the other.
    expect(ruleFor('.card-excerpt')).toMatch(/-webkit-line-clamp:\s*\d/);
  });

  it('keeps the footer on one line, so the counters cannot wrap the card taller', () => {
    const foot = ruleFor('.card-foot');
    expect(foot, 'the footer wraps').toMatch(/white-space:\s*nowrap/);
    expect(foot).toMatch(/overflow:\s*hidden/);
    expect(foot, 'the footer only wrapped because it was allowed to').not.toMatch(/flex-wrap/);
    // And it is pinned, so leftover height from a short title collects above it rather than
    // pushing it off the bottom.
    expect(foot).toMatch(/margin-top:\s*auto/);
  });

  it('lays Trending and Latest out two-up, so a card is a card wherever it sits', () => {
    // They were one card per row inside a half-width column, which is a 667px-wide card for a
    // single article — a stretched banner, out of scale with the 367px cards above it.
    const list = ruleFor('.ranked-list');
    expect(list, 'the ranked list is still a single column').toMatch(/display:\s*grid/);
    // `auto-fill` with a floor rather than `1fr 1fr`: when the split collapses to one column
    // on a narrow screen this becomes more cards across, not two enormous ones.
    expect(list).toMatch(/repeat\(auto-fill, minmax\(\d+px, 1fr\)\)/);
  });

  it('keeps the ranked list inside the same container as the header', () => {
    // The section and the header are both inside `.wrap`, so this is really a check that the
    // board was not pulled out of it — the complaint that started this was that the section
    // looked wider than the header, which it never was; the cards inside were.
    expect(css).toMatch(/\.wrap\s*\{[^}]*max-width:\s*var\(--wrap\)/);
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(cssNoComments, 'the split board sets its own width despite the wrap').not.toMatch(
      /\.board-split\s*\{[^}]*max-width/,
    );
  });
});
