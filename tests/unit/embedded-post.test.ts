import { expect, it } from 'vitest';
import { recoverEmbeddedPosts } from '../../src/parser/embedded-post';
import { parseMarkdownToDocument } from '../../src/parser/markdown';
import { inlineToText } from '../../src/types/article-document';

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
