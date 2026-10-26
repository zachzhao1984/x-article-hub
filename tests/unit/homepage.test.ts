import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The homepage's data fetching and its shelf.
 *
 * The homepage is the most-hit page in the archive and the only one that runs a
 * `Promise.all` of several D1 reads in parallel, so it is the page where a query nobody
 * renders is cheapest to add and easiest to miss. It happened: a "Browse by category"
 * grid at the foot of the page needed `listCategoriesWithCounts`, the grid was removed,
 * and the query stayed — a D1 read on every homepage load for a result nothing displayed.
 *
 * The rule is general rather than about that one call, which is why `renders everything it
 * fetches` is written against the template instead of against a list of the sections that
 * currently exist: the sections changed (three boards became a rack and a strip) and the
 * rule did not.
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

/**
 * Bindings that are consumed by a later `const`, not read by the template directly.
 *
 * `lead` becomes `feature`/`rest` and `cats` becomes `topics` on the next lines, so
 * searching the template for the original name is the wrong test — the query is used.
 */
const ALIASES: Record<string, string> = {
  lead: 'feature',
  cats: 'topics',
  authors: 'authorCount',
  newCount: 'articleCount',
  newest: 'justArchived',
};

describe('the homepage', () => {
  it('renders everything it fetches', () => {
    const body = code(template());
    const unused = boundNames().filter(
      (name) => !body.includes(name) && !(name in ALIASES && body.includes(ALIASES[name]!)),
    );
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

  it('shows each article on the page exactly once', () => {
    // The defect the shelf was built to end. The three-board version rendered 13 cards in
    // three sections and only 9 distinct articles: Latest's first three were Editor's
    // Pick's three in the same order, and one more was already in Trending. 26 links
    // pointed at 9 URLs, so a reader scrolling the page met the same article up to three
    // times and three of the thirteen slots taught them nothing.
    //
    // Asserted structurally: the rack takes one ordered slice, and the strip filters that
    // slice out by slug before rendering. Re-introducing a second query drawn from a
    // different ordering would have to defeat the filter in order to duplicate.
    // The slice and the filter live in the frontmatter, so both halves are read from it.
    const front = code(homepage.slice(0, homepage.indexOf('---', 3)));
    expect(front, 'the strip is not de-duplicated against the rack').toMatch(
      /newest\.filter\(\(a\) => !onRack\.has\(a\.id\)\)/,
    );
    expect(front, 'the rack no longer draws a single ordered slice').toMatch(
      /const \[feature, \.\.\.rest\] = lead/,
    );
    const body = code(template());
    expect(front).toContain("sort: 'trending', limit: 4");
    expect(front).toContain('new Set(lead.map((a) => a.id))');
    // And no second board-level row exists to reintroduce the overlap: the three sections
    // are gone, not merely reordered.
    expect(body).not.toContain('trending.map(');
    expect(body).not.toContain('latest.map(');
  });

  it('leads with the rack, not with a photograph', () => {
    // The band this replaces was 447px of a 900px first screen — 49.7% — with the first
    // article at y=594. It was also a public-domain photograph of antique book spines, so
    // the page opened on somebody else's books rather than on the archive's own covers.
    //
    // Asserted on both halves. Deleting the section but keeping `hero-library.webp` as a
    // background would satisfy a "no .home-hero" check and still open the page on the
    // photograph.
    const body = code(template());
    expect(body).not.toContain('home-hero');
    expect(body).not.toContain('hero-library');
    const css = code(readFileSync(resolve('public/site.css'), 'utf8'));
    expect(css, 'the hero stylesheet survived the section').not.toContain('.home-hero');
    expect(css, 'the hero photograph is still referenced').not.toContain('hero-library');
    // And the rack comes before the strip in reading order.
    const rack = body.indexOf('class="rack"');
    expect(rack, 'there is no rack').toBeGreaterThan(-1);
    expect(body.indexOf('class="strip"'), 'the strip precedes the rack').toBeGreaterThan(rack);
  });

  it('keeps a heading, so the page is not announced as untitled', () => {
    // The shelf leads with artwork and has no visible page title. The h1 is still there,
    // visually hidden — a headline-less top of page is how a document ends up unnamed.
    const body = code(template());
    expect(body).toMatch(/<h1 class="sr-only">/);
    expect(body).toMatch(/<section class="rack" aria-labelledby="rack-heading">/);
    expect(body).toMatch(/id="rack-heading"/);
  });

  it('prints the archive’s real size rather than a slogan', () => {
    // The old page stated its size nowhere: `/authors` carried "113 articles archived" and
    // the homepage carried no number at all, so a reader could not tell a nine-article
    // experiment from a 113-article library. Every figure below is bound from a query.
    const body = code(template());
    const front = code(homepage.slice(0, homepage.indexOf('---', 3)));
    // Rendered…
    expect(body).toContain('{articleCount}');
    expect(body).toContain('{authorCount}');
    expect(body).toContain('{topics.length}');
    // …and queried.
    expect(front).toContain('homepageCounts(db)');
    expect(front).toContain('COUNT(DISTINCT author_username)');
    expect(front).toContain('listCategoriesWithCounts(db)');
    // Empty topics are dropped rather than printed: a zero-count topic is not somewhere a
    // reader can browse into, and `science` currently holds no articles.
    expect(front).toContain('cats.filter((c) => c.count > 0)');
  });

  it('still links every board it summarises', () => {
    // The rack is Trending's top six and the strip is Latest's newest six; both must reach
    // the boards they are a sample of, or the page becomes the only way in.
    const body = code(template());
    expect(body).toContain('href="/trending"');
    expect(body).toContain('href="/latest"');
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
