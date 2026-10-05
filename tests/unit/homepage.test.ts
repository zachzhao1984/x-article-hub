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
    // section itself. This holds the difference: the header still lists every category
    // with its count, and `/category/:slug` is still in the sitemap.
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    expect(header).toContain('listCategoriesWithCounts');
    expect(header).toContain('/category/${c.slug}');
    expect(readFileSync(resolve('src/pages/sitemap.xml.ts'), 'utf8')).toContain('/category/${c.slug}');
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