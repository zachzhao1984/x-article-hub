import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §16 — hard delete.
 *
 * This is the only irreversible operation in the admin, and the only one that reaches
 * outside D1: every R2 key is derived from the article id (`articles/{id}/...`, SPEC §8), so
 * the D1 row is the *only pointer* to the archived objects. Delete the row first and the
 * objects become unreachable — nothing else records what was under that prefix.
 *
 * That is the whole correctness argument, and it is what the order assertion below pins.
 */

const service = readFileSync(resolve('src/services/delete-article.ts'), 'utf8');
const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');
const adminCss = readFileSync(resolve('public/admin.css'), 'utf8');
/** Every migration, concatenated. The cascade declarations are spread across several. */
const schema = readdirSync(resolve('migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(resolve('migrations', f), 'utf8'))
  .join('\n');

/** Source with its comments stripped, so an assertion is about code and not about prose. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('deleteArticleEverywhere', () => {
  it('removes the R2 objects before the row that points at them', () => {
    // The order is the correctness argument, not a style choice. `articles/{id}/` is derived
    // from the id, and the `articles` row is the only record that the prefix belongs to
    // anything — so a failure after the DELETE leaves objects no tool here can attribute.
    const body = code(service);
    const sweep = body.indexOf('ARCHIVE.delete');
    const rowDelete = body.indexOf('DELETE FROM articles');
    expect(sweep, 'the R2 sweep must exist').toBeGreaterThan(0);
    expect(rowDelete, 'the row delete must exist').toBeGreaterThan(0);
    expect(sweep, 'R2 must be swept before the row is dropped').toBeLessThan(rowDelete);
  });

  it('does not attempt to enumerate the child tables', () => {
    // Six tables reference `articles` and all six declare ON DELETE CASCADE, with
    // `PRAGMA foreign_keys` on in D1. Listing them here would be a second copy of the schema
    // that silently diverges: a table added later is handled by the cascade and missed by
    // the list.
    const body = code(service);
    for (const table of [
      'article_versions',
      'media_objects',
      'crawl_jobs',
      'curation_events',
      'article_tags',
      'article_metrics',
    ]) {
      expect(body, `${table} must not be deleted explicitly`).not.toMatch(
        new RegExp(`DELETE FROM ${table}`),
      );
    }
    // And the cascade really is declared, so the reasoning above holds rather than being an
    // assumption about the schema.
    for (const table of ['article_versions', 'media_objects', 'crawl_jobs', 'article_metrics']) {
      const block = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\);`).exec(schema)?.[1] ?? '';
      expect(block, `${table} must be declared somewhere`).not.toBe('');
      expect(block, `${table} must declare ON DELETE CASCADE`).toMatch(/ON DELETE CASCADE/);
    }
  });

  it('counts what it is about to remove, before removing it', () => {
    // After the cascade every count is zero, so a result assembled afterwards would report
    // zeros and the confirmation message would say nothing.
    const body = code(service);
    const count = body.indexOf('summarizeForDelete(env, articleId)');
    const rowDelete = body.indexOf('DELETE FROM articles');
    expect(count).toBeGreaterThan(0);
    expect(count, 'the counts must be taken while the rows still exist').toBeLessThan(rowDelete);
  });

  it('survives a missing row, so an orphaned prefix can be cleaned', () => {
    // `findOrphanedPrefixes` reports prefixes whose row is gone and cannot act on them.
    // Refusing here would leave the admin with no way to reclaim that storage.
    expect(code(service)).toMatch(/rowMissing: article === null/);
    // And no early return when the lookup finds nothing — the sweep still runs.
    const body = code(service);
    const lookup = body.indexOf('SELECT id, slug, title FROM articles');
    const sweep = body.indexOf('ARCHIVE.delete');
    expect(lookup).toBeLessThan(sweep);
    expect(body.slice(lookup, sweep)).not.toMatch(/if \(!article\) return/);
  });

  it('logs the deletion, since a destructive action with no trail is unreviewable', () => {
    expect(service).toMatch(/log\.warn\('article_deleted'/);
    // The actor matters more here than anywhere else in this codebase.
    expect(service).toMatch(/actor,/);
  });
});

describe('the delete route', () => {
  const handler = adminUi.slice(
    adminUi.indexOf("adminUi.post('/articles/:id/delete'"),
    adminUi.indexOf("adminUi.post('/articles/:id/publish'"),
  );

  it('requires the confirmation to match the slug', () => {
    // The browser dialog is a guard against a misclick, not a boundary: anything can POST
    // this URL. The server compares the submitted value against the article's own slug.
    expect(handler).toMatch(/form\.confirm/);
    expect(handler).toMatch(/article\?\.slug \?\? id/);
    // And refuses before doing any work when it does not match.
    const guard = handler.indexOf('delete-confirm-mismatch');
    const call = handler.indexOf('deleteArticleEverywhere');
    expect(guard).toBeGreaterThan(0);
    expect(guard, 'the refusal must come before the delete').toBeLessThan(call);
  });

  it('redirects to the list, not the article it just deleted', () => {
    // Returning to the detail page would 404 immediately after a successful action, which
    // reads as a failure.
    expect(handler).toMatch(/Location: `\/admin\/articles\?\$\{params\.toString\(\)\}`/);
    expect(handler).not.toMatch(/redirectToArticle\(c, id\) *;?\s*$/m);
  });

  it('reports what was removed', () => {
    // "Deleted" with no number cannot distinguish a full delete from one that swept an
    // empty prefix.
    expect(handler).toMatch(/objects: String\(result\.objects\)/);
    expect(handler).toMatch(/bytes: String\(result\.bytes\)/);
    expect(views).toMatch(/view\.deleted/);
  });
});

describe('the delete controls', () => {
  it('is on every row, unlike publish', () => {
    // Delete is not a state transition: any article can be removed regardless of where it
    // is in the pipeline. Gating it on a status would mean the only way to remove a bad
    // import is to archive it first.
    const listView = views.slice(
      views.indexOf('export function articleListView'),
      views.indexOf('function renderPager'),
    );
    const deleteCell = /const deleteCell = \(([\s\S]*?)\n\n/.exec(listView)?.[1] ?? '';
    expect(deleteCell, 'cannot locate deleteCell').not.toBe('');

    // The property is "this returns markup unconditionally", not "it does not mention a
    // status". An earlier version asserted the letter of that — `not.toMatch(/status ===/)` —
    // and a guard on any *other* field walked straight through it: adding
    // `slug === null ? '' : ...` left all fourteen tests green while hiding the button from
    // every article whose slug happened to be null.
    //
    // So the assertion is now structural. The function body must be a single expression that
    // is a template literal, with no conditional between the arrow and the markup.
    const arrowBody = deleteCell.slice(deleteCell.indexOf('=>') + 2).trim();
    expect(
      arrowBody.startsWith('`<form'),
      `deleteCell must return markup unconditionally, got: ${arrowBody.slice(0, 40)}`,
    ).toBe(true);
    // And no ternary anywhere in it, which is the shape any guard would take.
    expect(deleteCell, 'deleteCell must not be conditional').not.toMatch(/\?\s*''/);

    // It is actually rendered in the row.
    expect(listView).toMatch(/\$\{deleteCell\(a\.id,/);
  });

  it('sends the confirmation as the row\'s slug, not its id', () => {
    // The id is not visible anywhere in the UI. A confirmation an operator cannot check is
    // not a confirmation.
    const listView = views.slice(
      views.indexOf('export function articleListView'),
      views.indexOf('function renderPager'),
    );
    const deleteCell = /const deleteCell = \(([\s\S]*?)\n\n/.exec(listView)?.[1] ?? '';
    expect(deleteCell).toMatch(/value="\$\{escapeHtml\(slug \?\? id\)\}"/);
  });

  it('asks before deleting from the list, where there is no room to type', () => {
    // A table cell has no space for an input. The dialog is the shortcut path; the detail
    // page is where the deliberate type-it-out version lives.
    const listView = views.slice(
      views.indexOf('export function articleListView'),
      views.indexOf('function renderPager'),
    );
    const deleteCell = /const deleteCell = \(([\s\S]*?)\n\n/.exec(listView)?.[1] ?? '';
    expect(deleteCell).toMatch(/onsubmit="return confirm\(/);
    expect(deleteCell).toMatch(/This cannot be undone/);
  });

  it('says on the detail page what it will remove, and what to use instead', () => {
    // The section is the only place with room to explain the difference between this and
    // the reversible controls directly above it.
    expect(views).toMatch(/card-danger/);
    expect(views).toMatch(/This cannot be undone/);
    // It names the reversible alternatives, because that is the mistake it exists to prevent.
    expect(views).toMatch(/Archive<\/em> or <em>Takedown/);
    // The typed confirmation is on this surface.
    expect(views).toMatch(/name="confirm"/);
  });

  it('reads the confirmation notice in the same voice as the other refusals', () => {
    // The route redirects with this code and the detail page turns it into a sentence.
    expect(adminUi).toMatch(/delete-confirm-mismatch/);
    expect(adminUi).toMatch(/Nothing was removed/);
  });

  it('marks the section apart from the reversible ones', () => {
    // Everything else on that page can be undone. A red left rule is the smallest thing
    // that makes the boundary visible, and it reuses `--error` so there is one signal.
    expect(adminCss).toMatch(/\.card-danger \{[^}]*border-left:[^}]*var\(--error\)/);
    expect(adminCss).toMatch(/\.button-small/);
  });
});
