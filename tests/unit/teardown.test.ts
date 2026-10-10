import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The archive reset — `teardownArchive`.
 *
 * The one property that matters is the ordering, and it is the same one
 * `deleteArticleEverywhere` is built around: every R2 key is derived from the article id
 * (`articles/{id}/…`), so the `articles` rows are the only pointer to the archived bytes.
 * Delete the rows first and the objects become both unreachable and unidentifiable — nothing
 * records which prefix belonged to what, so they can never be swept and never be explained.
 *
 * The second property is scope. This is the endpoint that deliberately *does* what the
 * purge-prefix endpoint deliberately refuses, so the guard has to be a different one: an
 * explicit confirmation string, spelled out, rather than a rule about which rows count as
 * real content. Getting that wrong in either direction is the failure this file guards:
 * too loose and a stray request empties production, too tight and the operation cannot run.
 *
 * A third, quieter one is that reader accounts survive. A reset of the archive is not a
 * reason to log every reader out or destroy their identities, and `users` has no foreign key
 * from `articles` — so it would survive a naive `DELETE FROM articles` by accident, and is
 * asserted here so an explicit `DELETE FROM users` added later is caught.
 */

const service = readFileSync(resolve('src/services/teardown.ts'), 'utf8');
const api = readFileSync(resolve('src/routes/admin-api.ts'), 'utf8');

/** Source with its comments stripped, so an assertion is about code and not about prose. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('teardownArchive', () => {
  it('sweeps R2 before deleting the rows that point at it', () => {
    // The same invariant `delete-article.test.ts` pins, on the operation that is larger by
    // three orders of magnitude. The rows *are* the index of the bucket keys.
    const body = code(service);
    const sweep = body.indexOf('ARCHIVE.delete');
    const rowDelete = body.indexOf('DELETE FROM articles');
    expect(sweep, 'there is no R2 sweep').toBeGreaterThan(0);
    expect(rowDelete, 'articles are never deleted').toBeGreaterThan(0);
    expect(sweep, 'the row delete runs before the objects are swept').toBeLessThan(rowDelete);
  });

  it('deletes crawl_jobs explicitly, because nothing cascades them', () => {
    // Every other child table declares `ON DELETE CASCADE` on `article_id`; `crawl_jobs`
    // names the column without the constraint, so its rows outlive the articles they
    // belong to unless they are removed on purpose. A job pointing at a deleted article is
    // a dangling reference the admin would render as a broken row.
    const body = code(service);
    expect(body, 'crawl_jobs is not deleted').toContain('DELETE FROM crawl_jobs');
    // And before the articles, so the jobs never name a row that is already gone.
    expect(body.indexOf('DELETE FROM crawl_jobs')).toBeLessThan(body.indexOf('DELETE FROM articles'));
  });

  it('leaves reader accounts alone', () => {
    // `articles` has no foreign key to `users`, so this would survive by accident — which is
    // exactly why it is asserted rather than assumed.
    const body = code(service);
    for (const table of ['users', 'user_identities', 'user_sessions', 'oauth_states']) {
      expect(body, `${table} is deleted by the teardown`).not.toMatch(
        new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i'),
      );
    }
    // And the result reports them, so the operator sees they were retained rather than
    // having to take it on faith.
    expect(service).toMatch(/retained:/);
    expect(service).toMatch(/FROM users/);
  });

  it('puts the seeded categories back, so the reset is not a broken install', () => {
    // The acceptance script caught this the hard way: `/category/ai` returned 404 after the
    // first reset, because the categories are resolved by slug from `0002_seed_categories.sql`
    // — the schema's baseline, not content — and `seed-demo.ts` inserts articles with a
    // `(SELECT id FROM categories WHERE slug = ?)` subquery that silently yields null without
    // them. A reset has to leave a working install.
    const body = code(service);
    expect(body, 'the seeded categories are not restored').toMatch(/INSERT INTO categories/);
    // In the same batch as the delete, so the rows are never observably missing.
    const batchStart = body.indexOf('DB.batch(');
    const batchEnd = body.indexOf(']', body.indexOf('DELETE FROM categories'));
    expect(body.indexOf('INSERT INTO categories'), 'the restore is outside the batch').toBeLessThan(
      batchEnd,
    );
    expect(batchStart).toBeGreaterThan(0);
    // And the slugs the application resolves against, so a truncated copy fails here.
    for (const slug of ['cat_ai', 'cat_technology', 'cat_business', 'cat_science', 'cat_ideas']) {
      expect(body, `${slug} is not restored`).toContain(slug);
    }
  });

  it('runs the row deletes as one batch, since D1 rejects BEGIN/COMMIT', () => {
    // A half-applied reset leaves articles whose taxonomy and jobs are already gone. D1
    // rejects an explicit transaction, so `batch` is the only way to get atomicity here.
    const body = code(service);
    expect(body).toMatch(/DB\.batch\(/);
    expect(body, 'an explicit transaction is not possible on D1').not.toMatch(/\bBEGIN\b/);
  });

  it('guards the endpoint on a spelled-out confirmation, not the fixture rule', () => {
    // This is the deliberate inverse of purge-prefix: that one refuses real content and
    // exists for smoke fixtures, this one erases real content on purpose. Reusing the
    // fixture guard here would either weaken it or make this unreachable.
    expect(api).toMatch(/maintenance\/teardown/);
    const post = api.slice(api.indexOf("adminApi.post('/maintenance/teardown'"));
    const route = post.slice(0, post.indexOf('});'));
    expect(route, 'the teardown is not confirmed').toMatch(/body\.confirm !== 'teardown-archive'/);
    expect(route, 'the refused request must not proceed').toMatch(/throw new AppError/);
  });

  it('reports what a reset would remove before it happens', () => {
    // An irreversible delete cannot be confirmed without knowing its size, and reading the
    // counts afterwards reports zeroes.
    expect(api).toMatch(/adminApi\.get\('\/maintenance\/teardown'/);
    expect(api).toMatch(/wouldRemove:\s*await summarizeTeardown/);
    // The summary must count from the tables, not from a stored figure that could drift.
    expect(service).toMatch(/FROM articles\)/);
    expect(service).toMatch(/FROM media_objects\)/);
  });
});
