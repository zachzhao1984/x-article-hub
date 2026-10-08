import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §17.1 — the author index at `/authors`.
 *
 * Two things this page has to get right, and one it must not get wrong.
 *
 * It must list the people who actually wrote the archive, and it must not invent a
 * destination that renders empty when clicked. Both come from the same place: the count
 * here has to use the identical predicate `/author/[username]` uses, or the two disagree
 * and a name appears whose page has nothing in it.
 *
 * And it must not read the `authors` table. That table looks like the obvious source and
 * is a trap on a real archive — `seed-demo.ts` is its only writer, so it holds rows for
 * deleted demo content and nothing else, while every article still carries its author.
 */

const page = readFileSync(resolve('src/pages/authors.astro'), 'utf8');
const authorPage = readFileSync(resolve('src/pages/author/[username].astro'), 'utf8');
const db = readFileSync(resolve('src/db/public.ts'), 'utf8');
const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
const css = readFileSync(resolve('public/site.css'), 'utf8');
const middleware = readFileSync(resolve('src/middleware.ts'), 'utf8');
const request = readFileSync(resolve('src/middleware.ts'), 'utf8');

/** Source with its comments stripped, so an assertion is about code and not about prose. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

describe('/authors', () => {
  it('lists authors from the articles, not from the authors table', () => {
    // The page renders whatever `listAuthors` returns, so this is really about what that
    // function reads — and it reads `articles`. Asserted because the `authors` table is a
    // plausible-looking source that is empty on this deployment: its only writer is
    // `seed-demo.ts`, so it holds six rows for demo content that was deleted, and zero
    // rows for the six real authors.
    expect(page).toMatch(/listAuthors/);
    expect(code(page)).not.toMatch(/FROM authors|from '\.\.\/db\/authors'/);

    // And the query itself still aggregates the article side, with the same predicate the
    // single-author page uses.
    const list = db.slice(db.indexOf('export async function listAuthors'));
    expect(list).toMatch(/FROM articles a/);
    expect(list).toMatch(/a\.status = 'published' AND a\.display_mode != 'takedown'/);
    expect(list).toMatch(/GROUP BY a\.author_username/);
  });

  it('counts articles the same way the author page does', () => {
    // If these predicates drift, an author can be listed here and then show an empty grid
    // when clicked — the failure being that the link works and the destination is blank.
    const list = db.slice(db.indexOf('export async function listAuthors'), db.indexOf('export async function getAuthor'));
    const single = db.slice(db.indexOf('export async function getAuthor'));

    // The two shared conditions, spelled identically in both.
    for (const predicate of ["a.status = 'published'", "a.display_mode != 'takedown'"]) {
      expect(list, `listAuthors must filter on ${predicate}`).toContain(predicate);
      expect(single, `getAuthor must filter on ${predicate}`).toContain(predicate);
    }

    // The third differs in form rather than in meaning, and asserting the same string in
    // both would be wrong: the single-author page is *asked* for one username, so `= ?`
    // already excludes null and an extra `IS NOT NULL` would be redundant. The list is
    // asked for everyone, so it is the only one that needs to say it.
    expect(list).toContain('a.author_username IS NOT NULL');
    expect(single).toContain('a.author_username = ?');
    // `= ?` cannot match NULL, which is what makes the two equivalent.
    expect(list).not.toContain('a.author_username = ?');
  });

  it('links every entry to that author\'s archive', () => {
    // The whole point of the page. One link per author, to the route that already exists.
    expect(page).toMatch(/href=\{`\/author\/\$\{author\.username\}`\}/);
    // And that route is real, not a made-up path — it is the page that already renders the
    // filtered grid.
    expect(authorPage).toMatch(/listPublishedArticles\(db, \{ authorUsername: username/);
  });

  it('links once per author rather than once per name', () => {
    // A link wrapping both the avatar and the name. Two links to the same href would give
    // a keyboard two tab stops and a screen reader the same destination twice.
    const anchors = code(page).match(/<a\b/g) ?? [];
    expect(anchors, 'exactly one anchor per author entry').toHaveLength(1);
    // The avatar and the name are both inside it, so both are clickable.
    expect(page).toMatch(/<a class="author-link"[\s\S]*?author-avatar[\s\S]*?author-display/);
  });

  it('gives the avatar an empty alt and the entry a real label', () => {
    // The avatar is decorative here — the name beside it is the label. A real alt would
    // make a screen reader announce the image before the name it belongs to.
    expect(page).toMatch(/class="author-avatar"[\s\S]{0,200}alt=""/);
    // The stand-in letter is hidden for the same reason: it duplicates the name's initial.
    expect(page).toMatch(/author-avatar-letter" aria-hidden="true"/);
  });

  it('has a stand-in for an author with no picture', () => {
    // Same fallback shape as the header slot, and for the same reason: a fixed-width image
    // column with nothing in it reads as a broken row rather than as a missing avatar.
    expect(page).toMatch(/author\.avatar_url \?/);
    expect(page).toMatch(/author-avatar-letter/);
    expect(css).toMatch(/\.author-avatar-letter \{[^}]*border-radius|\.author-avatar \{/);
  });

  it('falls back to the handle when there is no display name', () => {
    // `display_name` is nullable and comes from the page metadata. A blank heading is the
    // failure, and the handle is already on the same row so it is never worse.
    expect(page).toMatch(/author\.display_name\?\.trim\(\) \|\| `@\$\{author\.username\}`/);
  });

  it('does not wrap a long display name onto a second line', () => {
    // One long X name must not make its grid row taller than its neighbours.
    expect(css).toMatch(/\.author-display \{[^}]*text-overflow: ellipsis/);
    expect(css).toMatch(/\.author-display \{[^}]*white-space: nowrap/);
  });

  it('is cached, because it does not differ per reader', () => {
    // The predicate in the TTL table is "does this page differ per reader". This one reads
    // only published articles, so it does not. `/featured` was missing from the same table
    // for as long as it existed, which is the mistake this is here to prevent recurring.
    const ttl = middleware.slice(middleware.indexOf('TTL_SECONDS'), middleware.indexOf('];'));
    expect(ttl).toMatch(/authors/);
    expect(ttl).toMatch(/featured/);

    // And it must not be swallowed by the no-store branch. `/authors` starts with the four
    // characters `/aut`, so a prefix test for the auth segment matches it and makes it
    // uncacheable — invisible, because the page renders correctly and is simply never
    // cached. The branch has to name the segment exactly.
    //
    // The pattern below is assembled rather than written out, because spelling it literally
    // in this comment makes the assertion match its own explanation. That has now happened
    // four times in this repository; the fix each time is to assert on stripped code or to
    // stop writing the forbidden string down.
    const prefixForm = "startsWith('/" + 'auth' + "')";
    expect(middleware).not.toContain(prefixForm);
    expect(middleware).toContain("path === '/auth'");
    expect(middleware).toContain("path.startsWith('/auth/')");
  });

  it('is in the navigation, which is what the tab was for', () => {
    // Before this, `/author/*` was reachable only from a card's byline — you had to
    // already know whose name to look for.
    expect(header).toMatch(/\{ href: '\/authors', label: 'Authors', icon: 'users' \}/);
    // The label matches the route so the active state works: `isActive` matches path
    // prefixes, and a label pointing somewhere else would highlight the wrong tab.
    expect(header).toMatch(/isActive = \(href: string\)/);
  });

  it('says so rather than rendering an empty grid', () => {
    // The archive could legitimately be empty, and an empty `<ul>` is a blank page.
    expect(page).toMatch(/authors\.length === 0/);
    expect(page).toMatch(/empty-state/);
  });

  it('caps the list without silently truncating', () => {
    // The cap exists so the page cannot grow without bound. Ordered by article count, so a
    // truncated list keeps the most prolific — but a silent cut would be a lie, so the
    // count shown is the number actually rendered.
    expect(page).toMatch(/const AUTHORS_SHOWN = \d+/);
    expect(page).toMatch(/listAuthors\(db, AUTHORS_SHOWN\)/);
    // The heading counts what is on the page, not a separate total.
    expect(page).toMatch(/authors\.length/);
  });
});
