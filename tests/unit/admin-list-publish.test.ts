import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §16.3 — the Publish quick action in the article list.
 *
 * Two things are easy to get wrong here and both are invisible in a screenshot.
 *
 * The button must appear on `review` rows and no others. `review` is the state an editor has
 * decided on; every other state either has nothing to publish yet, is already out, or was
 * deliberately stopped, and a publish button on those would offer a transition the state
 * machine does not have.
 *
 * And the action has to come *back* to the list. The route it posts to is shared with the
 * detail page, whose Publish button redirects to the article — correct there, and wrong
 * here: clicking publish on row 7 of a filtered list must not navigate away from row 7 of
 * that list.
 */

const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');
const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
const admin = readFileSync(resolve('public/admin.css'), 'utf8');

/** Source with its comments stripped, so an assertion is about code and not about prose. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of `articleListView`, bounded by the next top-level export. */
const listView = () => {
  const start = views.indexOf('export function articleListView');
  const end = views.indexOf('function renderPager');
  expect(start, 'cannot locate articleListView').toBeGreaterThanOrEqual(0);
  return views.slice(start, end);
};

describe('the article list quick action', () => {
  it('offers publish on review rows only', () => {
    // The condition, not the button: `publishCell` returns markup for one status and the
    // empty string for every other, so the guard is what decides where the action appears.
    const cell = /const publishCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell, 'cannot locate publishCell').not.toBe('');
    expect(cell).toMatch(/status === 'review'/);

    // And nothing else is offered. Asserted as an exhaustive list rather than a spot check,
    // because adding a second status is the change most likely to be made carelessly.
    const otherStatuses = [
      'pending',
      'fetching',
      'fetched',
      'parsing',
      'published',
      'rejected',
      'archived',
      'takedown',
      'failed',
    ];
    for (const status of otherStatuses) {
      expect(cell, `publish must not be offered for ${status}`).not.toMatch(
        new RegExp(`status (?:===|==) '${status}'`),
      );
    }
  });

  it('posts rather than links, because publishing changes state', () => {
    // A GET that changes state is what lets a prefetch or a link preview publish something.
    const cell = /const publishCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell).toMatch(/<form method="post"/);
    expect(cell).not.toMatch(/<a [^>]*href="\/admin\/articles\/[^"]*\/publish/);
    // The detail page's Publish is a form for the same reason, and still is.
    expect(views).toMatch(/<form method="post" action="\/admin\/articles\/\$\{escapeHtml\(a\.id\)\}\/publish"/);
  });

  it('tells the handler it came from the list', () => {
    // The marker the redirect keys on. Without it the shared route sends the editor to the
    // article detail page — which is right for the detail page's own button and wrong here.
    // The hidden fields moved into `listReturnFields` when a second and third row action
    // needed them; `publishCell` now calls it. Asserted on the helper and on the call,
    // because the field has to actually reach the form rather than merely exist.
    const list = listView();
    const fields = /const listReturnFields = \(([\s\S]*?)\n\n/.exec(list)?.[1] ?? '';
    expect(fields, 'cannot locate listReturnFields').not.toBe('');
    expect(fields).toMatch(/name="from" value="list"/);
    const publishCell = /const publishCell = \(([\s\S]*?)\n\n/.exec(list)?.[1] ?? '';
    expect(publishCell, 'publishCell must send the marker').toMatch(/listReturnFields\(filter\)/);
  });

  it('carries the status filter so the list comes back the way it was', () => {
    // The article has just left `review`. Landing on an unfiltered list of everything
    // would hide the row that changed, which is the one row the editor wants to see.
    const list = listView();
    const fields = /const listReturnFields = \(([\s\S]*?)\n\n/.exec(list)?.[1] ?? '';
    expect(fields).toMatch(/name="status"/);
    // Escaped, like everything else interpolated into markup.
    expect(fields).toMatch(/escapeHtml\(filter\)/);

    // The helper is where the filter is applied now that three actions share it.
    const helper = adminUi.slice(adminUi.indexOf('function listReturn('), adminUi.indexOf('function redirectToArticle('));
    expect(helper, 'cannot locate listReturn').not.toBe('');
    expect(helper).toMatch(/params\.set\('status', status\)/);
  });

  it('returns to the list when asked, and to the article otherwise', () => {
    // Both branches, in that order, with the list one gated on the marker.
    // Both halves, now in one place: the handler delegates, and the helper decides.
    const handler = adminUi.slice(
      adminUi.indexOf("adminUi.post('/articles/:id/publish'"),
      adminUi.indexOf("adminUi.post('/articles/:id/reject'"),
    );
    expect(handler).toMatch(/listReturn\(c, await c\.req\.parseBody\(\), 'published'\)/);
    // The detail-page path is unchanged: this must not have become a list-only route.
    expect(handler).toMatch(/return redirectToArticle\(c, id\)/);

    const helper = adminUi.slice(adminUi.indexOf('function listReturn('), adminUi.indexOf('function redirectToArticle('));
    expect(helper).toMatch(/if \(form\.from !== 'list'\) return null/);
    expect(helper).toMatch(/Location: `\/admin\/articles\?\$\{params\.toString\(\)\}`/);

    // Rebuilt from one known piece plus one validated value, never from the submitted form:
    // an attacker-chosen path in a Location header is an open redirect, and only the status
    // decides what the editor was looking at.
    expect(helper).toMatch(/new URLSearchParams\(\{ notice \}\)/);
    expect(helper).not.toMatch(/new URLSearchParams\(form/);
  });

  it('confirms what happened, because the row disappears from a review filter', () => {
    // With the list filtered to `review`, a successful publish removes the row. A row
    // vanishing is indistinguishable from a filter being wrong or an unexpected reload.
    expect(listView()).toMatch(/view\.notice/);
    expect(listView()).toMatch(/banner-ok/);
    // And the route passes the notice that selects the message.
    expect(adminUi).toMatch(/notice: c\.req\.query\('notice'\) \?\? null/);
  });

  it('toggles the featured label to match the current state', () => {
    // The label reports the state, not the action — a featured article says `Unfeature`.
    // That is what makes it read as a toggle rather than a one-way transition, which is the
    // difference from Publish: Publish is disabled once it has happened, because there is
    // nothing to un-publish to.
    const cell = /const featuredCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell, 'cannot locate featuredCell').not.toBe('');
    expect(cell).toMatch(/\$\{featured \? 'Unfeature' : 'Feature'\}/);
    // The title attribute says the same thing, so the button is not the only place it is
    // stated — hovering and screen-reading both get it.
    expect(cell).toMatch(/featured \? 'Remove from Editor/);
    expect(cell).toMatch(/Mark as Editor/);
  });

  it('offers the toggle on every row, regardless of status', () => {
    // Deciding something is worth featuring is a judgement about the article, not about
    // whether it has gone live yet — an editor marks picks before publishing.
    //
    // Asserted structurally rather than as `not.toMatch(/status ===/)`: that phrasing passed
    // on a guard added to any other field, and did the same thing in this file for
    // `deleteCell`. Wrapping the body in `featured === null ? '' : …` left every test green
    // while hiding the button from any row whose `featured` happened to be null — which is
    // every row, since the column is nullable and most articles are not picks.
    const cell = /const featuredCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell, 'cannot locate featuredCell').not.toBe('');
    const arrowBody = cell.slice(cell.indexOf('=>') + 2).trim();
    expect(
      arrowBody.startsWith('`<form'),
      `featuredCell must return markup unconditionally, got: ${arrowBody.slice(0, 40)}`,
    ).toBe(true);
    // The arrow body is measured only up to the markup, so the ternaries *inside* the
    // template — the label and the title — are not what this is about. An earlier version
    // also asserted the whole cell contained no `? ''`, which every correct version does,
    // because that is how the button's label is chosen.

    // And it is actually rendered, in its own column.
    expect(listView()).toMatch(/\$\{featuredCell\(a\.featured, a\.id, view\.status\)\}/);
  });

  it('takes the target state from the row, not from the request', () => {
    // A form rendered before somebody else featured the article must not flip it back:
    // reading the stored value and inverting it is the only version that is correct when two
    // editors have the list open.
    const route = adminUi.slice(
      adminUi.indexOf("adminUi.post('/articles/:id/featured'"),
      adminUi.indexOf("adminUi.post('/articles/:id/takedown'"),
    );
    expect(route).toMatch(/const article = await getArticleById/);
    expect(route).toMatch(/const nowFeatured = article\?\.featured !== 1/);
    expect(route).toMatch(/setFeatured\(c\.env, id, c\.get\('adminIdentity'\)\.actor, nowFeatured\)/);
  });

  it('comes back to the list, and says which way it went', () => {
    // Two notices, because "featured" and "unfeatured" are different outcomes and one
    // message for both would be wrong half the time.
    const route = adminUi.slice(
      adminUi.indexOf("adminUi.post('/articles/:id/featured'"),
      adminUi.indexOf("adminUi.post('/articles/:id/takedown'"),
    );
    expect(route).toMatch(/nowFeatured \? 'featured' : 'unfeatured'/);
    // The detail-page path still lands on the article.
    expect(route).toMatch(/return redirectToArticle\(c, id\)/);

    const view = listView();
    expect(view).toMatch(/featured: /);
    expect(view).toMatch(/unfeatured: /);
  });

  it('selects the notice from a fixed table rather than echoing it', () => {
    // `notice` arrives in a query string anybody can send. Interpolating it would be a way to
    // put text on a page that looks like it came from the admin.
    const view = listView();
    expect(view).toMatch(/const NOTICES: Record<string, string>/);
    expect(view).toMatch(/NOTICES\[view\.notice\]/);
    expect(view).not.toMatch(/banner-ok">\$\{view\.notice/);
  });

  it('keeps the list table aligned with the action columns', () => {
    // The action buttons each live in their own column. A header row with the wrong number
    // of `<th>` shifts every column and is the kind of thing that only shows up at a narrow
    // width.
    //
    // Eight now — status, pick, title, author, imported, source, publish, delete. Asserted
    // as an exact count on both sides so adding a cell to one and not the other fails here.
    const thead = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(listView())?.[1] ?? '';
    expect(thead, 'cannot locate the list header').not.toBe('');
    expect((thead.match(/<th/g) ?? []).length).toBe(8);
    const row = /`<tr>([\s\S]*?)<\/tr>`/.exec(listView())?.[1] ?? '';
    expect(row, 'cannot locate the list row').not.toBe('');
    expect((row.match(/<td/g) ?? []).length).toBe(8);
  });

  it('sizes the row button so rows with an action are not taller', () => {
    // The default form margin would push the button off the row's baseline and make every
    // review row taller than every other row in the same table.
    expect(admin).toMatch(/\.row-action \{ display: inline; margin: 0; \}/);
    expect(admin).toMatch(/\.button-small \{ padding: 4px 12px;/);
  });
});
