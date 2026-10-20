import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const views = readFileSync(resolve('src/routes/views.ts'), 'utf8');
const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
const publishService = readFileSync(resolve('src/services/publish.ts'), 'utf8');

describe('automatic publication in admin', () => {
  it('does not offer a Publish button for a newly imported article awaiting parse', () => {
    const list = views.slice(views.indexOf('export function articleListView'), views.indexOf('function renderPager'));
    const detail = views.slice(views.indexOf('export function articleDetailView'));
    expect(list).not.toMatch(/publishCell|title="Publish this article"/);
    expect(detail).not.toMatch(/<button class="button" type="submit"[^>]*>Publish<\/button>/);
    expect(list).toMatch(/\$\{featuredCell\(a\.featured, a\.id, view\.status\)\}/);
    expect(list).toMatch(/\$\{deleteCell\(a\.id, a\.title \|\| a\.canonical_url, a\.slug\)\}/);
    const thead = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(list)?.[1] ?? '';
    const row = /`<tr>([\s\S]*?)<\/tr>`/.exec(list)?.[1] ?? '';
    expect((thead.match(/<th/g) ?? []).length).toBe(7);
    expect((row.match(/<td/g) ?? []).length).toBe(7);
  });

  it('keeps the existing API but refuses an article without a parsed document', () => {
    expect(adminUi).toMatch(/adminUi\.post\('\/articles\/:id\/publish'/);
    expect(publishService).toMatch(/!article\.content_r2_key/);
    expect(publishService).toMatch(/article\.block_count < 1/);
  });
});
