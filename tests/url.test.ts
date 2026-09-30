import { describe, expect, it } from 'vitest';
import { buildArticleSlug, normalizeArticleUrl, slugify, splitUrlInput } from '../src/lib/url';

/**
 * SPEC §5.2 — URL normalization is the dedup key for the whole system
 * (SPEC §5.3), so these cases double as the definition of "the same article".
 */
describe('normalizeArticleUrl', () => {
  it('accepts a canonical article URL unchanged', () => {
    const result = normalizeArticleUrl('https://x.com/karpathy/article/1234567890123456789');
    expect(result).toMatchObject({
      ok: true,
      value: {
        canonicalUrl: 'https://x.com/karpathy/article/1234567890123456789',
        sourceUrl: 'https://x.com/karpathy/article/1234567890123456789',
        xArticleId: '1234567890123456789',
        username: 'karpathy',
      },
    });
  });

  it('strips tracking query params and fragments', () => {
    const result = normalizeArticleUrl('https://x.com/foo/article/123?s=20&t=aBcD&cx=123#fragment');
    expect(result.ok && result.value.canonicalUrl).toBe('https://x.com/foo/article/123');
  });

  it('keeps meaningful query params on sourceUrl but not on the canonical key', () => {
    const result = normalizeArticleUrl('https://x.com/foo/article/123?s=20&lang=en');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canonicalUrl).toBe('https://x.com/foo/article/123');
    expect(result.value.sourceUrl).toBe('https://x.com/foo/article/123?lang=en');
  });

  it('removes the fragment before splitting the path', () => {
    const result = normalizeArticleUrl('https://x.com/foo/article/123#');
    expect(result.ok && result.value.canonicalUrl).toBe('https://x.com/foo/article/123');
  });

  it('normalizes twitter.com and www/mobile hosts to x.com', () => {
    const urls = [
      'https://twitter.com/foo/article/123',
      'https://www.twitter.com/foo/article/123',
      'https://mobile.twitter.com/foo/article/123',
      'https://www.x.com/foo/article/123',
      'https://mobile.x.com/foo/article/123',
    ];
    for (const url of urls) {
      const result = normalizeArticleUrl(url);
      expect(result.ok, url).toBe(true);
      if (result.ok) expect(result.value.canonicalUrl, url).toBe('https://x.com/foo/article/123');
    }
  });

  it('forces https', () => {
    const result = normalizeArticleUrl('http://x.com/foo/article/123');
    expect(result.ok && result.value.canonicalUrl).toBe('https://x.com/foo/article/123');
  });

  it('accepts a scheme-less paste', () => {
    const result = normalizeArticleUrl('  x.com/foo/article/123  ');
    expect(result.ok && result.value.canonicalUrl).toBe('https://x.com/foo/article/123');
  });

  it('treats differently cased hosts as the same article', () => {
    const a = normalizeArticleUrl('https://X.com/Foo/article/123');
    const b = normalizeArticleUrl('https://x.com/foo/article/123');
    expect(a.ok && b.ok && a.value.canonicalUrl === b.value.canonicalUrl).toBe(true);
  });

  it('survives percent-encoded path segments', () => {
    const result = normalizeArticleUrl('https://x.com/%6Barpathy/article/%31%32%33');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.canonicalUrl).toBe('https://x.com/karpathy/article/123');
  });

  it('does not treat an encoded slash as a path separator', () => {
    const result = normalizeArticleUrl('https://x.com/foo%2Fbar/article/123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_AN_ARTICLE');
  });

  it('does not throw on a malformed percent escape', () => {
    expect(() => normalizeArticleUrl('https://x.com/%zz/article/123')).not.toThrow();
  });

  it.each([
    ['https://example.com/foo/article/123', 'UNSUPPORTED_HOST'],
    ['https://x.com/foo/status/123', 'NOT_AN_ARTICLE'],
    ['https://x.com/foo', 'NOT_AN_ARTICLE'],
    ['https://x.com/', 'NOT_AN_ARTICLE'],
    ['https://x.com/foo/article/', 'NOT_AN_ARTICLE'],
    ['https://x.com/foo/article/abc', 'NOT_AN_ARTICLE'],
    ['https://x.com/this_username_is_far_too_long/article/123', 'NOT_AN_ARTICLE'],
    ['not a url at all', 'INVALID_URL'],
    ['ftp://x.com/foo/article/123', 'INVALID_URL'],
    ['', 'EMPTY_INPUT'],
    ['   ', 'EMPTY_INPUT'],
  ])('rejects %s with %s', (input, code) => {
    const result = normalizeArticleUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });
});

describe('splitUrlInput', () => {
  it('splits on newlines, commas and semicolons and trims', () => {
    expect(splitUrlInput(' https://x.com/a/article/1 ,\nhttps://x.com/b/article/2 ;\n\n https://x.com/c/article/3 ')).toEqual([
      'https://x.com/a/article/1',
      'https://x.com/b/article/2',
      'https://x.com/c/article/3',
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(splitUrlInput('   \n  \n')).toEqual([]);
  });
});

describe('slugs', () => {
  it('builds a stable slug from username and article id', () => {
    expect(buildArticleSlug('karpathy', '123')).toBe('karpathy-123');
    expect(buildArticleSlug('Some_User', '999')).toBe('some-user-999');
  });

  it('never returns an empty slug', () => {
    expect(slugify('---')).toBe('untitled');
  });
});
