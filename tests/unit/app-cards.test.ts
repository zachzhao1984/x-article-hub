import { describe, expect, it } from 'vitest';
import { extractAppCardMeta } from '../../src/parser/app-cards';
import { parseMarkdownToDocument } from '../../src/parser/markdown';
import { documentToPlainText } from '../../src/types/article-document';

const PAGE = 'https://x.com/u/article/1';
const OPTIONS = { url: PAGE, capturedAt: '2026-10-15', parserVersion: 18 };

describe('extractAppCardMeta', () => {
  it('reads the Open Graph banner the plugin page serves', () => {
    const html = [
      '<html><head>',
      '<meta property="og:title" content="pstack for Grok Bot">',
      // Content before property on purpose: attribute order is not guaranteed.
      '<meta content="https://x.ai/bot/plugin/9717366/opengraph-image-1vmpwd" property="og:image">',
      '<meta property="og:description" content="rigorous agent workflows">',
      '</head></html>',
    ].join('');

    expect(extractAppCardMeta(html)).toEqual({
      title: 'pstack for Grok Bot',
      imageUrl: 'https://x.ai/bot/plugin/9717366/opengraph-image-1vmpwd',
      description: 'rigorous agent workflows',
    });
  });

  it('refuses a banner that x.ai does not serve', () => {
    const html = '<meta property="og:image" content="https://example.com/banner.png">';
    expect(extractAppCardMeta(html)).not.toHaveProperty('imageUrl');
  });

  it('returns nothing rather than half a card', () => {
    expect(extractAppCardMeta('<html><head></head></html>')).toEqual({});
  });
});

describe('a bare x.ai plugin link in an article', () => {
  it('becomes an app card, not a paragraph of URL text', () => {
    const { document } = parseMarkdownToDocument(
      'Before.\n\nhttps://x.ai/bot/plugin/9717366\n\nAfter.',
      OPTIONS,
    );
    expect(document.blocks[1]).toEqual({ type: 'app', url: 'https://x.ai/bot/plugin/9717366' });
  });

  it('leaves a plugin link that shares its paragraph alone', () => {
    const { document } = parseMarkdownToDocument(
      'Use [pstack](https://x.ai/bot/plugin/9717366) for this workflow.',
      OPTIONS,
    );
    expect(document.blocks[0]?.type).toBe('paragraph');
  });

  it('stays searchable: the card carries the URL and the plugin title', () => {
    const { document } = parseMarkdownToDocument('https://x.ai/bot/plugin/9717366', OPTIONS);
    document.blocks[0] =
      document.blocks[0]?.type === 'app'
        ? { ...document.blocks[0], title: 'pstack for Grok Bot' }
        : document.blocks[0]!;

    expect(documentToPlainText(document)).toContain('https://x.ai/bot/plugin/9717366');
    expect(documentToPlainText(document)).toContain('pstack for Grok Bot');
  });
});