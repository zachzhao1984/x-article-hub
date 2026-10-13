import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The homepage's data fetching.
 *
 * The homepage is the most-hit page in the archive and the only one that runs a
 * `Promise.all` of several D1 reads in parallel, so it is the page where a query nobody
 * renders is cheapest to add and easiest to miss. It happened: a "Browse by category"
 * grid at the foot of the page needed `listCategoriesWithCounts`, the grid was removed,
 * and the query stayed — a D1 read on every homepage load for a result nothing displayed.
 *
 * The rule is general rather than about that one call. Every name bound from the
 * `Promise.all` has to appear in the template, so the next section to be deleted cannot
 * quietly leave its query behind.
 */

const homepage = readFileSync(resolve('src/pages/index.astro'), 'utf8');

/**
 * Source with its comments removed, for the negative assertions.
 *
 * Both of the "this is gone" tests below were written as plain substring searches and
 * both failed against the comment explaining why the thing is gone —
 * `listCategoriesWithCounts` appears in the note about dropping its query, and
 * `.cat-card` appears in the stylesheet comment listing the rules that were deleted. An
 * assertion that congratulates itself for removing something while naming it in the
 * explanation is not an assertion about the code, so every "must not contain" here goes
 * through this.
 */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');

/** The template, i.e. everything after the frontmatter fence. */
function template(): string {
  const fences = [...homepage.matchAll(/^---$/gm)].map((m) => m.index ?? 0);
  expect(fences.length, 'the frontmatter fence was not found').toBeGreaterThanOrEqual(2);
  return homepage.slice(fences[1]!);
}

/** The names the homepage binds from its parallel queries. */
function boundNames(): string[] {
  const declaration = /const\s*\[([^\]]+)\]\s*=\s*await Promise\.all\(\[/.exec(homepage);
  expect(declaration, 'the homepage no longer destructures a Promise.all').not.toBeNull();
  return (declaration?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

describe('the homepage', () => {
  it('renders everything it fetches', () => {
    const body = code(template());
    const unused = boundNames().filter((name) => !body.includes(name));
    expect(unused, `fetched and never rendered: ${unused.join(', ')}`).toEqual([]);
  });

  it('fetches something', () => {
    // So the assertion above cannot pass by the destructuring having gone away — which
    // it would, since `boundNames()` returns an empty set and every filter over an
    // empty set is empty.
    expect(boundNames().length).toBeGreaterThan(2);
  });

  it('no longer renders the category grid', () => {
    // Asserted as absent rather than merely unreferenced, because the point of removing
    // it was that the page is shorter. A `.cat-grid` rule left behind would not bring
    // the section back, but it would read as though it were still coming.
    expect(code(homepage)).not.toContain('Browse by category');
    expect(code(homepage)).not.toContain('cat-grid');
    expect(code(homepage)).not.toContain('listCategoriesWithCounts');
  });

  it('keeps categories reachable from the header', () => {
    // The removal is one entrance to a section that is still on the sitemap, not the
    // section itself. The header now reaches every category through the filter `<select>`
    // beside the search box rather than a row of chips: each slug is still an option and
    // still navigates to `/category/<slug>`. `/category/:slug` is still in the sitemap.
    //
    // The counts are gone with the chips. They are all zero — no published article carries
    // a category — so `AI (0)` was not information, and the option is 108px wide with 71px
    // of text room, where "Technology (0)" (86px) would truncate while "Technology" (66px)
    // fits. The count returns with the first article that is actually categorised, and it
    // belongs on the category page, not in a control too narrow to show it.
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    expect(header).toContain('listCategoriesWithCounts');
    expect(header).toContain('value={c.slug}');
    expect(header).not.toContain('{c.count}');
    expect(header).toMatch(/this\.value \? '\/category\/' \+ this\.value/);
    expect(readFileSync(resolve('src/pages/sitemap.xml.ts'), 'utf8')).toContain('/category/${c.slug}');
  });

  it('leads with the editor\'s picks, not the trending board\'s top three', () => {
    // The row was `trending.slice(0, 3)` under the title "Today's Selection", which is
    // the trending board's own first three shown a second time on the same page. It is
    // now the `featured` query — the human override, and the same query `/featured` runs,
    // so the row and the board it links to cannot disagree about what a pick is.
    //
    // Asserted on the query, not the title: renaming the heading while leaving the
    // trending query underneath would satisfy every check that only looked at wording,
    // and would be a heading that lies about its own contents.
    expect(code(homepage)).toContain("listPublishedArticles(db, { sort: 'featured', limit: 3 })");
    expect(code(homepage)).not.toContain('trending.slice');
    expect(code(homepage)).not.toContain("Today's Selection");
    // And the row links to the board, so the new nav entry is reachable from the page
    // that features its content.
    expect(code(homepage)).toContain('href="/featured"');
  });

  it('prints the picks once, not twice', () => {
    // The lead row and the old "⭐ Editor's Picks" section were the same `featured` array.
    // Moving the title up without deleting the lower section would have put the same three
    // articles on the page twice, which is what a reader would have seen — nothing about
    // either section is invalid on its own.
    const board = code(template());
    // Counted on the map, not on a title. An earlier version of this assertion counted the
    // picks' heading string and reported two as a duplication, when two was the layout —
    // the hero subtitle and the board heading both carried it. The hero is gone now, so
    // that ambiguity is gone with it, but counting the map is the assertion that still
    // means what it says.
    expect(board.match(/featured\.map\(/g)?.length ?? 0, 'the picks are rendered once').toBe(1);
    // The plural, emoji-decorated heading is the one that went.
    expect(board).not.toContain("Editor's Picks");
    // The star emoji went with it. Every UI glyph here is a vendored Phosphor path — a
    // featured card's badge uses one, and the nav now uses `star` for this board — so a
    // Unicode star in a heading would be the second icon system this repo removed on
    // purpose.
    expect(board).not.toContain('⭐');
  });

  it('serves the picks from the filter, not the sort expression', () => {
    // `SORT_SQL.featured` is `published_at DESC` with no mention of `a.featured`, so on
    // the ordering alone this board would be a fourth copy of /latest. What makes it a
    // board is a WHERE clause, in the query layer — and that is easy to lose in a refactor
    // that only looks at the sort map.
    const publicDb = readFileSync(resolve('src/db/public.ts'), 'utf8');
    expect(publicDb).toContain("if (sort === 'featured') where.push('a.featured = 1');");

    const board = readFileSync(resolve('src/pages/featured.astro'), 'utf8');
    expect(code(board)).toContain('sort="featured"');
    expect(code(board)).toContain('path="/featured"');
  });

  it('fills the space Rising left with Latest, not with emptiness', () => {
    // The Rising board occupied the right-hand column of `.board-split` and was removed with
    // the velocity signal it ranked by. A `1fr 1fr` grid with one child is a two-column
    // layout with a hole in it, which reads as a section that failed to load.
    //
    // Latest is the replacement because it is the board whose contents cannot be inferred
    // from the others: every card in Trending is in Latest by definition, but the two
    // orderings disagree, so the pair shows what is moving alongside what is new.
    // The query is in the frontmatter and the rendering is in the template, so the two are
    // asserted against the parts of the file they live in rather than both against the body.
    expect(code(homepage)).toContain("listPublishedArticles(db, { sort: 'latest', limit: 5 })");

    const board = code(template());
    expect(board).toContain('latest.map(');
    expect(board).toContain('href="/latest"');

    // Both boards sit inside the split, so the grid has its two children back.
    const open = board.indexOf('<div class="board-split">');
    expect(open, 'cannot locate board-split').toBeGreaterThanOrEqual(0);
    const split = board.slice(open);
    expect(split).toContain('trending.map(');
    expect(split).toContain('latest.map(');
  });

  it('distinguishes a ranking from a chronology in the markup', () => {
    // Trending is an `<ol>` with rank numbers because it orders by score; Latest is the same
    // list without them because it orders by time. Passing `rank` to both would claim Latest
    // is a ranking, and dropping it from both would lose Trending's.
    const board = code(template());
    expect(board).toContain('<ArticleCard article={a} rank={i + 1} />');
    expect(board).toMatch(/latest\.map\(\(a\) => \(\s*<li>\s*<ArticleCard article={a} \/>/);
  });

  it('does not mention Rising anywhere on the page', () => {
    // The section is gone, and a heading or link left behind would point at a 404.
    expect(code(homepage)).not.toContain('/rising');
    expect(code(homepage)).not.toContain('Rising');
  });

  it('leaves no CSS behind for the section it dropped', () => {
    // Four rules and three members of the 1.5 line-height group, all of which became
    // dead in the same edit. A selector nothing renders reads as live and gets restyled
    // later; `.cat-count` is the one that has to survive, because the header's chips and
    // this page's tag cloud both still use it.
    const css = code(readFileSync(resolve('public/site.css'), 'utf8'));
    for (const selector of ['.cat-grid', '.cat-card', '.cat-name', '.cat-desc']) {
      expect(css, `${selector} is still declared`).not.toContain(selector);
    }
    expect(css).toContain('.cat-count');
  });
});