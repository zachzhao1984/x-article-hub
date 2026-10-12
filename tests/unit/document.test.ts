import { describe, expect, it } from 'vitest';
import { buildFtsQuery } from '../../src/db/public';
import { countWords, documentToPlainText, type ArticleDocument } from '../../src/types/article-document';

describe('buildFtsQuery (SPEC §12)', () => {
  it('quotes each token so FTS syntax characters cannot be injected', () => {
    expect(buildFtsQuery('agents')).toBe('"agents"');
    expect(buildFtsQuery('ai agents')).toBe('"ai" "agents"');
  });

  it('strips FTS operators from user input', () => {
    // A raw `*` or `"` would otherwise produce a SQL/FTS syntax error instead
    // of "no results".
    expect(buildFtsQuery('foo*')).toBe('"foo"');
    expect(buildFtsQuery('"foo"')).toBe('"foo"');
    expect(buildFtsQuery('a AND b')).toBe('"a" "AND" "b"');
    // No whitespace, so this is a single token: the punctuation is stripped,
    // not treated as a separator.
    expect(buildFtsQuery('near(10)')).toBe('"near10"');
    expect(buildFtsQuery('col:val')).toBe('"colval"');
  });

  it('returns null for input with nothing searchable', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('***')).toBeNull();
    expect(buildFtsQuery('"')).toBeNull();
  });

  it('caps the token count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(' ');
    expect(buildFtsQuery(many)!.split(' ')).toHaveLength(12);
  });
});

describe('documentToPlainText (SPEC §13.4)', () => {
  const doc: ArticleDocument = {
    title: 'The Title',
    author: { name: 'A', username: 'a' },
    publishedAt: '2026-01-01T00:00:00.000Z',
    blocks: [
      { type: 'paragraph', spans: [{ type: 'text', text: 'First paragraph.' }] },
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'A heading' }] },
      { type: 'quote', spans: [{ type: 'text', text: 'A quoted line.' }] },
      { type: 'list', ordered: false, items: [[{ type: 'text', text: 'item one' }], [{ type: 'text', text: 'item two' }]] },
      { type: 'code', code: 'const x = 1;' },
      { type: 'image', imageId: 'img_1' },
      { type: 'embed', postId: '123' },
    ],
    links: [{ href: 'https://example.com', text: 'a link' }],
    images: [],
    source: { url: 'https://x.com/a/article/1', parserVersion: 1, capturedAt: '2026-01-01T00:00:00.000Z' },
  };

  it('includes indexable text and excludes non-text blocks', () => {
    const text = documentToPlainText(doc);
    expect(text).toContain('The Title');
    expect(text).toContain('First paragraph.');
    expect(text).toContain('A heading');
    expect(text).toContain('A quoted line.');
    expect(text).toContain('item one');
    expect(text).toContain('const x = 1;');
  });

  it('never emits raw HTML or markup that a model or index should not see', () => {
    expect(documentToPlainText(doc)).not.toMatch(/<[a-z]/i);
  });

  it('drops media-only blocks', () => {
    const text = documentToPlainText(doc);
    expect(text).not.toContain('img_1');
    expect(text).not.toContain('123');
  });
});

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  padded   words  ')).toBe(2);
  });

  it('returns zero for empty text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});
