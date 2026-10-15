import { describe, expect, it } from 'vitest';
import { recoverArticleCards, recoverEmbeddedPosts, splitEmbeddedArticleCard } from '../../src/parser/embedded-post';
import { parseMarkdownToDocument } from '../../src/parser/markdown';
import { documentToPlainText, inlineToText } from '../../src/types/article-document';

it('recovers an embedded post without its duration and engagement UI', () => {
  const md = 'Before.\n\n[![@OpenAI](https://pbs.twimg.com/a.jpg)](https://x.com/OpenAI)\n\n' +
    '[OpenAI](https://x.com/OpenAI)\n\n[@OpenAI](https://x.com/OpenAI)\n\n' +
    '[Oct 7](https://x.com/OpenAI/status/123)\n\nGPT announcement.\n\n01:08\n\n' +
    '[1.1K](https://x.com/compose/post?in_reply_to=123)\n\n1.8K\n\n23K\n\n5.8M\n\nAfter.';
  expect(recoverEmbeddedPosts(md, '<div data-href="/i/web/status/123">').posts).toEqual([
    { postId: '123', url: 'https://x.com/OpenAI/status/123', author: 'OpenAI', handle: 'OpenAI', text: 'GPT announcement.' },
  ]);
  expect(recoverEmbeddedPosts(md, '<div data-href="/i/web/status/123">').markdown)
    .toBe('Before.\n\n\n\nXEMBEDPOST123\n\n\n\nAfter.');
  expect(recoverEmbeddedPosts(md, '').markdown).toBe(md);
  const recovered = recoverEmbeddedPosts(md, '<div data-href="/i/web/status/123">');
  const { document } = parseMarkdownToDocument(recovered.markdown, {
    url: 'https://x.com/u/article/1', capturedAt: '2026-10-13', parserVersion: 12,
  });
  const marker = document.blocks[1];
  expect(marker?.type === 'paragraph' ? inlineToText(marker.spans) : '').toBe('XEMBEDPOST123');
});

const CARD_MARKDOWN =
  "I'm writing a guide to pstack! Here's part one.\n\n" +
  '[![Article cover image](https://pbs.twimg.com/media/HQ_0MA_aMAA9zMt?format=webp&name=medium) ' +
  'Article The Complete Guide to pstack Pt. 1 In this series of posts, I am going to show you how I use pstack... ' +
  'rigorous engineering work.](https://x.com/i/article/2094457600259842065)';

const CARD_HTML =
  '<a class="x-link" href="/i/article/2094457600259842065"><div class="relative aspect-5/2">' +
  '<img alt="Article cover image" src="https://pbs.twimg.com/media/HQ_0MA_aMAA9zMt?format=webp&amp;name=medium">' +
  '<div aria-label="Article">Article</div></div><div class="p-3">' +
  '<div class="text-headline2 font-extrabold mb-2 break-words" dir="auto">The Complete Guide to pstack Pt. 1</div>' +
  '<div class="text-body line-clamp-4" dir="auto">In this series of posts, I am going to show you how I use pstack... rigorous engineering work.</div>' +
  '</div></a>';

describe('a quoted X Article inside a quoted post', () => {
  it('reads the title and excerpt from the capture instead of guessing them', () => {
    const cards = recoverArticleCards(CARD_HTML);
    const split = splitEmbeddedArticleCard(CARD_MARKDOWN, cards);
    expect(split.card).toEqual({
      url: 'https://x.com/i/article/2094457600259842065',
      imageUrl: 'https://pbs.twimg.com/media/HQ_0MA_aMAA9zMt?format=webp&name=medium',
      title: 'The Complete Guide to pstack Pt. 1',
      excerpt: 'In this series of posts, I am going to show you how I use pstack... rigorous engineering work.',
    });
  });

  it('takes the Markdown card out of the post text', () => {
    const split = splitEmbeddedArticleCard(CARD_MARKDOWN, recoverArticleCards(CARD_HTML));
    expect(split.text).toBe("I'm writing a guide to pstack! Here's part one.");
    expect(split.text).not.toContain('![');
  });

  it('still produces a card when the capture had no structured HTML', () => {
    const split = splitEmbeddedArticleCard(CARD_MARKDOWN);
    expect(split.card?.url).toBe('https://x.com/i/article/2094457600259842065');
    expect(split.card?.title).toContain('The Complete Guide to pstack Pt. 1');
    expect(split.text).not.toContain('pbs.twimg.com');
  });

  it('puts the card title and excerpt back into the searchable text', () => {
    const split = splitEmbeddedArticleCard(CARD_MARKDOWN, recoverArticleCards(CARD_HTML));
    const doc = {
      title: 'Guide',
      author: { name: 'lauren', username: 'poteto' },
      blocks: [
        { type: 'embed' as const, postId: '1', text: split.text, ...(split.card ? { card: split.card } : {}) },
      ],
      links: [],
      images: [],
      source: { url: 'https://x.com/u/article/1', parserVersion: 19, capturedAt: '2026-10-15' },
    };
    const plain = documentToPlainText(doc);
    expect(plain).toContain('The Complete Guide to pstack Pt. 1');
    expect(plain).not.toContain('![Article cover image]');
  });
});
