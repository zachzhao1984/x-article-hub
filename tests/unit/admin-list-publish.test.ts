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
    const cell = /const publishCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell).toMatch(/name="from" value="list"/);
  });

  it('carries the status filter so the list comes back the way it was', () => {
    // The article has just left `review`. Landing on an unfiltered list of everything
    // would hide the row that changed, which is the one row the editor wants to see.
    const cell = /const publishCell = \(([\s\S]*?)\n\n/.exec(listView())?.[1] ?? '';
    expect(cell).toMatch(/name="status"/);
    // Escaped, like everything else interpolated into markup.
    expect(cell).toMatch(/escapeHtml\(filter\)/);

    const handler = adminUi.slice(adminUi.indexOf("'/articles/:id/publish'"));
    expect(handler).toMatch(/params\.set\('status', status\)/);

    // Rebuilt from two known pieces, never from a caller-supplied string: an attacker-chosen
    // path in a Location header is an open redirect, and only the status is carried over.
    expect(handler).toMatch(/new URLSearchParams\(\{ published: '1' \}\)/);
    expect(handler).not.toMatch(/new URLSearchParams\(form/);
  });

  it('returns to the list when asked, and to the article otherwise', () => {
    // Both branches, in that order, with the list one gated on the marker.
    const handler = adminUi.slice(
      adminUi.indexOf("adminUi.post('/articles/:id/publish'"),
      adminUi.indexOf("adminUi.post('/articles/:id/reject'"),
    );
    expect(handler).toMatch(/if \(form\.from === 'list'\)/);
    expect(handler).toMatch(/Location: `\/admin\/articles\?\$\{params\.toString\(\)\}`/);
    // The detail-page path is unchanged: this must not have become a list-only route.
    expect(handler).toMatch(/return redirectToArticle\(c, id\)/);
  });

  it('confirms what happened, because the row disappears from a review filter', () => {
    // With the list filtered to `review`, a successful publish removes the row. A row
    // vanishing is indistinguishable from a filter being wrong or an unexpected reload.
    expect(listView()).toMatch(/view\.published/);
    expect(listView()).toMatch(/banner-ok/);
    // And the route sets the flag that turns it on.
    expect(adminUi).toMatch(/published: c\.req\.query\('published'\) === '1'/);
  });

  it('keeps the list table aligned with the action columns', () => {
    // The action buttons each live in their own column. A header row with the wrong number
    // of `<th>` shifts every column and is the kind of thing that only shows up at a narrow
    // width.
    //
    // Seven since the delete button was added — status, title, author, imported, source,
    // publish, delete. Asserted as an exact count on both sides so adding a cell to one and
    // not the other fails here.
    const thead = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(listView())?.[1] ?? '';
    expect(thead, 'cannot locate the list header').not.toBe('');
    expect((thead.match(/<th/g) ?? []).length).toBe(7);
    const row = /`<tr>([\s\S]*?)<\/tr>`/.exec(listView())?.[1] ?? '';
    expect(row, 'cannot locate the list row').not.toBe('');
    expect((row.match(/<td/g) ?? []).length).toBe(7);
  });

  it('sizes the row button so rows with an action are not taller', () => {
    // The default form margin would push the button off the row's baseline and make every
    // review row taller than every other row in the same table.
    expect(admin).toMatch(/\.row-action \{ display: inline; margin: 0; \}/);
    expect(admin).toMatch(/\.button-small \{ padding: 4px 12px;/);
  });
});
