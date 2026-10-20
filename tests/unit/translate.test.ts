import { describe, expect, it, vi } from 'vitest';
import { readTranslation, translateArticleBatch, translationUnits } from '../../src/services/translate';
import type { ArticleDocument } from '../../src/types/article-document';

const article: ArticleDocument = {
  title: 'A useful guide', author: { name: 'Author', username: 'author' },
  source: { url: 'https://x.com/author/article/1', parserVersion: 27, capturedAt: '2026-10-20' },
  links: [], images: [{ imageId: 'img_1', sourceUrl: 'https://example.com/image', r2Key: 'image.webp', status: 'ready' }],
  blocks: [
    { type: 'paragraph', spans: [{ type: 'text', text: 'The first paragraph.' }, { type: 'link', text: 'Read more', href: 'https://example.com' }] },
    { type: 'image', imageId: 'img_1' },
    { type: 'code', code: 'const x = 1;', language: 'js' },
    { type: 'list', ordered: false, items: [[{ type: 'text', text: 'A useful item.' }]] },
    { type: 'embed', postId: '123', text: 'External post' },
  ],
};
const articleId = 'art_test';
const sourceKey = `articles/${articleId}/versions/v1/article.json`;

function harness() {
  const objects = new Map<string, string>([[sourceKey, JSON.stringify(article)]]);
  const dbRow = { content_r2_key: sourceKey, status: 'published', display_mode: 'full' };
  const calls: string[][] = [];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => dbRow }) }) },
    ARCHIVE: {
      get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
      put: async (key: string, value: string) => { objects.set(key, value); },
      delete: async (key: string) => { objects.delete(key); },
    },
    AI: { run: vi.fn(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      const texts = (JSON.parse(input.messages[1]!.content) as { texts: string[] }).texts;
      calls.push(texts);
      return { response: JSON.stringify({ translations: texts.map((text) => `中${text}`) }) };
    }) },
  };
  return { env: env as unknown as Env, objects, dbRow, calls };
}

describe('article translation', () => {
  it('preserves block order, links, media and code while translating article text', () => {
    const { units, translated } = translationUnits(article);
    units.forEach((unit) => unit.assign(`中${unit.text}`));
    expect(translated.title).toBe('中A useful guide');
    expect(translated.blocks[0]).toEqual({ type: 'paragraph', spans: [
      { type: 'text', text: '中The first paragraph.' },
      { type: 'link', text: '中Read more', href: 'https://example.com' },
    ] });
    expect(translated.blocks.slice(1, 3)).toEqual(article.blocks.slice(1, 3));
    expect(translated.blocks[4]).toEqual(article.blocks[4]);
    expect(article.blocks[0]).not.toEqual(translated.blocks[0]);
  });

  it('keeps partial translation private and resumes to a complete versioned document', async () => {
    const { env, objects, calls } = harness();
    const first = await translateArticleBatch(env, articleId);
    expect(first).toMatchObject({ done: true, translated: 4, total: 4 });
    const result = await readTranslation(env.ARCHIVE, articleId, sourceKey);
    expect(result?.blocks[0]).toMatchObject({ type: 'paragraph', spans: [{ text: '中The first paragraph.' }, { text: '中Read more' }] });
    expect(calls).toHaveLength(1);
    expect(objects.has(`articles/${articleId}/translations/v1/zh.progress.json`)).toBe(false);
    await translateArticleBatch(env, articleId);
    expect(calls).toHaveLength(1);
    expect(await readTranslation(env.ARCHIVE, articleId, `articles/${articleId}/versions/v2/article.json`)).toBeNull();
  });

  it('does not publish an incomplete or malformed AI response', async () => {
    const { env, objects } = harness();
    (env.AI.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: '{"translations":["one"]}' });
    await expect(translateArticleBatch(env, articleId)).rejects.toThrow('invalid translation batch');
    expect([...objects.keys()].filter((key) => key.includes('/translations/'))).toEqual([]);
  });

  it('accepts the production chat completion response shape', async () => {
    const { env } = harness();
    (env.AI.run as ReturnType<typeof vi.fn>).mockImplementation(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      const texts = (JSON.parse(input.messages[1]!.content) as { texts: string[] }).texts;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: texts.map((t) => `中${t}`) }) } }] };
    });
    expect((await translateArticleBatch(env, articleId)).done).toBe(true);
  });

  it('resumes a long article after the first batch without publishing half a translation', async () => {
    const { env, objects, calls } = harness();
    const long = structuredClone(article);
    long.blocks[0] = { type: 'paragraph', spans: [{ type: 'text', text: 'One full sentence. '.repeat(150) }] };
    objects.set(sourceKey, JSON.stringify(long));
    const first = await translateArticleBatch(env, articleId);
    expect(first.done).toBe(false);
    expect(first.translated).toBeGreaterThan(0);
    expect(first.translated).toBeLessThan(first.total);
    expect(await readTranslation(env.ARCHIVE, articleId, sourceKey)).toBeNull();
    let result = first;
    for (let i = 0; !result.done && i < 10; i++) result = await translateArticleBatch(env, articleId);
    expect(result.done).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    const translated = await readTranslation(env.ARCHIVE, articleId, sourceKey);
    expect(translated?.blocks[0]).toMatchObject({ type: 'paragraph', spans: [{ type: 'text' }] });
    const text = translated?.blocks[0]?.type === 'paragraph' ? translated.blocks[0].spans[0]?.text : '';
    expect(text?.replaceAll('中', '')).toBe('One full sentence. '.repeat(150));
    expect(text?.split('中').length).toBeGreaterThan(2);
  });
});
