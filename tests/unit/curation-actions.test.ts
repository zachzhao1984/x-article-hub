import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveCategoryOverride } from '../../src/services/publish';
import { articleDetailView } from '../../src/routes/views';
import type { ArticleRow } from '../../src/db/rows';

/**
 * SPEC §16.3 — the editor's category control.
 *
 * This exists because of a real, shipping defect. Every icon and every category chip on
 * the public site read zero, and the reason was not a bug in the count query: the
 * columns were genuinely NULL on all five published articles. `overrideCategory` existed
 * the whole time and was reachable through `PATCH /api/admin/articles/:id` — and the
 * admin page had no control for it. A service with no caller and no UI is the shape this
 * guard is meant to catch, and the "every curation action is reachable" test at the
 * bottom is the generalisation.
 *
 * Nothing here needs a D1 binding. The mapping from a submitted form value to a stored
 * one is a pure function precisely so it can be checked here, and the view is a string
 * template.
 */

const CATEGORIES = [
  { id: 'cat_ai', slug: 'ai', name: 'AI' },
  { id: 'cat_technology', slug: 'technology', name: 'Technology' },
  { id: 'cat_business', slug: 'business', name: 'Business' },
];

const publishSource = readFileSync(resolve('src/services/publish.ts'), 'utf8');
const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');

function articleRow(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 'art_1',
    source_url: 'https://x.com/i/status/1',
    canonical_url: 'https://x.com/i/status/1',
    x_article_id: '1',
    x_post_id: null,
    slug: 'someone-1',
    title: 'An article',
    excerpt: null,
    author_id: null,
    author_name: 'Someone',
    author_username: 'someone',
    author_avatar: null,
    published_at: 1,
    imported_at: 1,
    status: 'published',
    category_id: null,
    ai_summary: null,
    ai_category: null,
    ai_confidence: null,
    editor_category_id: null,
    editor_summary: null,
    quality_score: null,
    popularity_score: null,
    velocity_score: null,
    editor_score: null,
    final_score: null,
    parser_version: 5,
    content_r2_key: null,
    raw_r2_key: 'raw/1',
    featured: 0,
    display_mode: 'full',
    takedown_requested_at: null,
    takedown_reason: null,
    word_count: 0,
    block_count: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  } as ArticleRow;
}

function render(article: ArticleRow, categories = CATEGORIES): string {
  return articleDetailView(
    {
      article,
      jobs: [],
      events: [],
      categories,
      raw: null,
      parsed: null,
      media: [],
      notice: null,
      error: null,
    },
    'X Article Hub',
  );
}

/** The `<option>` list of the category select, in order. */
function options(html: string): string[] {
  return [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1] ?? '');
}

describe('the category form value', () => {
  it('treats an empty submission as clearing the override', () => {
    // The select's first option is "— none —" with an empty value. Storing that string
    // would be a category id that matches nothing, and because the column is read
    // through a LEFT JOIN the article would just quietly fall back to uncategorised
    // while the audit trail claimed an override had been set.
    expect(resolveCategoryOverride(CATEGORIES, '')).toBeNull();
    expect(resolveCategoryOverride(CATEGORIES, '   ')).toBeNull();
    expect(resolveCategoryOverride(CATEGORIES, null)).toBeNull();
  });

  it('passes a known id through', () => {
    expect(resolveCategoryOverride(CATEGORIES, 'cat_ai')).toBe('cat_ai');
  });

  it('refuses an unknown id by name rather than storing it', () => {
    // A soft reference plus a LEFT JOIN means a bad value is invisible: the article
    // reappears as uncategorised and nothing reports an error. The audit event would
    // name a category that does not exist.
    expect(() => resolveCategoryOverride(CATEGORIES, 'cat_nope')).toThrow(/Unknown category: cat_nope/);
    // A slug is not an id. The column stores ids, and the two differ — `ai` is the slug,
    // `cat_ai` the id — so accepting a slug would be a second silent no-op.
    expect(() => resolveCategoryOverride(CATEGORIES, 'ai')).toThrow(/Unknown category/);
    expect(() => resolveCategoryOverride([], 'cat_ai')).toThrow(/Unknown category/);
  });
});

describe('the category control on the article page', () => {
  it('offers every category plus a clear option', () => {
    const html = render(articleRow());
    expect(html).toContain('name="categoryId"');
    expect(html).toContain(`/admin/articles/art_1/category`);
    // The blank option has to exist or there is no way to undo a mistake from here.
    expect(options(html)).toEqual(['', 'cat_ai', 'cat_technology', 'cat_business']);
  });

  it('shows the effective category selected, and says where it came from', () => {
    // `COALESCE(editor_category_id, category_id)` is how every read resolves this, and
    // a picker showing the effective value without saying which column supplied it is how
    // an editor "fixes" a value that was never wrong.
    const override = render(articleRow({ category_id: 'cat_ai', editor_category_id: 'cat_business' }));
    expect(override).toContain('<option value="cat_business" selected>');
    expect(override).not.toContain('<option value="cat_ai" selected>');
    expect(override).toContain('from your override');

    const assigned = render(articleRow({ category_id: 'cat_technology' }));
    expect(assigned).toContain('<option value="cat_technology" selected>');
    expect(assigned).toContain('assigned directly');

    // An accepted AI suggestion is a third state, and `ai_category` holds a slug where
    // the other two hold ids — worth distinguishing rather than lumping in with
    // "assigned directly".
    const suggested = render(articleRow({ category_id: 'cat_ai', ai_category: 'ai' }));
    expect(suggested).toContain('<option value="cat_ai" selected>');
    expect(suggested).toContain('from the AI suggestion');

    const none = render(articleRow());
    expect(none).toContain('<option value="" selected>');
    expect(none).toContain('nothing has categorised this article');
  });

  it('does not preselect an editor override that points nowhere', () => {
    // A dangling id predates the service validating its input, and it is invisible by
    // construction: the join cannot match it, so the article is in no category while the
    // column still holds a value. Rendering it as a selection would claim otherwise, and
    // leaving the select with nothing selected would make the page depend on which option
    // the browser defaults to.
    const html = render(articleRow({ editor_category_id: 'cat_deleted' }));
    expect(html).not.toContain('value="cat_deleted"');
    expect(html).toContain('<option value="" selected>');
    // And it names the stale value, rather than quietly reading as an uncategorised
    // article — the editor is the only one who can fix a column, so they are told which.
    expect(html).toContain('stale value (cat_deleted)');
  });

  it('posts as a plain form, so it works without scripting', () => {
    // The rest of this surface is forms for the same reason. A control that needs
    // JavaScript is a control that silently does nothing for anyone who disabled it,
    // which is the failure this whole episode started from.
    const html = render(articleRow());
    expect(/<form method="post" action="\/admin\/articles\/art_1\/category"[^>]*>/.test(html)).toBe(true);
    expect(html).toMatch(/<button class="button" type="submit">Save<\/button>/);
  });
});

describe('every curation action is reachable from a surface', () => {
  /**
   * Actions deliberately without an editor entry, each with the reason it is allowed to
   * stay. Reviewed rather than permanent: an entry that becomes reachable fails the test
   * below, so this list cannot rot into a hiding place.
   */
  const NOT_EDITOR_REACHABLE: Record<string, string> = {
    applyRankingScores: 'SPEC §21 ranking refresh, a Phase 6 cron that does not exist yet. No cron is registered.',
    overrideSummary:
      'SPEC §16.3 summary override: reachable through the API only, no form yet. Same gap this file was written for, on the other column.',
    restoreArticle: 'Dead export — nothing calls it anywhere. `restoreDisplay` is what the Restore button uses.',
  };

  it('has no curation action that nothing can reach', () => {
    const exported = [...publishSource.matchAll(/^export async function (\w+)/gm)].map((m) => m[1] ?? '');
    expect(exported.length).toBeGreaterThan(8);

    const unreachable = exported.filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(adminUi) && !(name in NOT_EDITOR_REACHABLE),
    );
    expect(unreachable, `reachable by nothing: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('keeps the exception list honest', () => {
    // Each exception has to still be unreachable, or it is hiding a working control
    // behind a comment that says it is missing.
    for (const [name, reason] of Object.entries(NOT_EDITOR_REACHABLE)) {
      expect(reason.length, `${name} needs a reason, not a dash`).toBeGreaterThan(20);
      if (new RegExp(`\\b${name}\\b`).test(adminUi)) {
        throw new Error(`${name} is now reachable from the admin UI — remove it from NOT_EDITOR_REACHABLE`);
      }
    }
  });

  it('renders a form for every action the UI registers', () => {
    // The other direction: a route with no form is a handler only a script can reach,
    // which is how `overrideCategory` sat unused for the length of a phase.
    const routes = [...adminUi.matchAll(/adminUi\.post\('\/articles\/:id\/(\w+)'/g)].map((m) => m[1] ?? '');
    expect(routes.length).toBeGreaterThan(8);
    for (const route of routes) {
      expect(views, `POST /articles/:id/${route} has no form in the article page`).toContain(`/${route}"`);
    }
  });

  it('keeps the notice and the error on separate channels', () => {
    // They render in different banners, so a confirmation arriving as `error` would be
    // styled as a refusal — and an editor who has just categorised an article should not
    // be told they failed.
    expect(adminUi).toContain("redirectToArticle(c, id, undefined, 'category-saved')");
    expect(views).toContain('banner banner-ok');
    expect(views).toContain('banner banner-error');
  });
});