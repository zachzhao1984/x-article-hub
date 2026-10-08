import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The import results table, and the two vocabularies it has to keep apart.
 *
 * This exists because of one report. An operator re-imported a URL they had already
 * imported, saw the pill read `duplicate`, and reasonably read it as a claim about the
 * article — "this has been reviewed". It is not: `duplicate` is the SPEC §5.3 outcome
 * meaning "this import created nothing", while `reviewed` would be a statement about the
 * article's workflow status. They coincided for that one article, which is exactly what
 * makes conflating them dangerous: pasting an already-**published** URL would have shown
 * the same "reviewed" pill for an article that was live.
 *
 * So the two answers are now separate — the outcome says what the import did, a second
 * pill says what happened to the article that was already there — and the on-screen word
 * for the outcome is one that is actually true.
 */

const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');
const importer = readFileSync(resolve('src/services/import.ts'), 'utf8');
const admin = readFileSync(resolve('public/admin.css'), 'utf8');
const smoke = readFileSync(resolve('scripts/smoke.sh'), 'utf8');

/** Source with its comments removed, so the assertions below are about code. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the import results table', () => {
  it('does not label a duplicate as though it described the article', () => {
    // The label is a map lookup, not the wire value: `duplicate` has to stay on the wire
    // because `scripts/smoke.sh` asserts on it and it is part of the SPEC §22 shape, but
    // it must not reach the screen as a claim about review state.
    expect(code(views)).toContain("duplicate: 'already imported'");
    const banner = /already imported/.test(code(views));
    expect(banner, 'the summary line still says "duplicate"').toBe(true);
    // And the word is gone from the rendered summary, not just relabelled in the pill.
    expect(code(views)).not.toMatch(/duplicates\} duplicate/);
  });

  it('shows the existing article\'s status beside the outcome', () => {
    // The gap that made the original wording confusing: nothing told the operator whether
    // the article they had just re-imported was finished, live, or still waiting.
    expect(views).toMatch(/articleStatus\?: string/);
    expect(code(views)).toMatch(/pill-\$\{escapeHtml\(o\.articleStatus\)\}/);
    // Both pills, in that cell — the outcome and the state are not merged.
    expect(code(views)).toMatch(/pill-\$\{escapeHtml\(o\.status\)\}[\s\S]{0,200}o\.articleStatus/);
    // And they share a nowrap row. Left as bare inline elements the column width wrapped
    // them, so "already imported" sat on one line and "published" on the next — which
    // reads as two results for one URL rather than two facts about one.
    expect(code(views)).toContain('class="pill-group"');
    expect(admin).toMatch(/\.pill-group \{[^}]*flex-wrap: nowrap/);
    // …and the label itself must not break. `flex-wrap: nowrap` alone kept the two pills
    // on one line while still letting "already imported" wrap inside its own pill, which
    // squeezed the column instead of widening it.
    expect(admin).toMatch(/\.pill-group \{[^}]*white-space: nowrap/);
  });

  it('carries that status from the import service', () => {
    expect(importer).toMatch(/articleStatus\?: ArticleStatus/);
    // Matched against the comment-stripped source: the `pending` branch carries five
    // lines of note explaining why it is not read from the database, and a span tight
    // enough to be readable failed on the prose rather than on the structure.
    const src = code(importer);
    // The row that exists: read from the article, so it is the real state.
    expect(src).toMatch(/articleId: existing\.id,\s*\n\s*articleStatus: existing\.status,/);
    // The in-batch repeat cannot be read, because the batched INSERT has not run yet.
    expect(src).toMatch(/articleId: inBatch\.articleId,[\s\S]{0,120}articleStatus: 'pending'/);
  });

  it('keeps the wire value, because the acceptance check reads it', () => {
    // Renaming `ImportOutcome.status` would have been a breaking change to a documented
    // response shape, for a label that only ever appears on one screen.
    expect(importer).toMatch(/status: 'created' \| 'duplicate' \| 'failed'/);
    expect(smoke).toContain('.duplicates');
    expect(smoke).toContain('o.status==="duplicate"');
  });

  it('styles a pill for every status the table can now render', () => {
    // The consequence of rendering an arbitrary `articleStatus`: two of the ten workflow
    // states had no `.pill-*` rule, so a duplicate of an article mid-crawl or one kept but
    // unpublished rendered a pill with no colour — which reads as a label that failed to
    // style rather than one that was never meant to.
    const styled = new Set([...admin.matchAll(/\.pill-([a-z-]+)/g)].map((m) => m[1] ?? ''));
    for (const status of [
      'pending',
      'fetching',
      'fetched',
      'parsing',
      'review',
      'published',
      'rejected',
      'archived',
      'takedown',
      'failed',
    ]) {
      expect(styled.has(status), `.pill-${status} has no rule`).toBe(true);
    }
  });
});
