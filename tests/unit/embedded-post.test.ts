import { describe, expect, it } from 'vitest';
import { extractPostMedia, recoverArticleCards, recoverEmbeddedPosts, recoverNestedPosts, recoverPostIdentities, splitEmbeddedArticleCard, splitNestedPost } from '../../src/parser/embedded-post';
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

const NESTED_HTML =
  '<div data-href="/poteto/status/2078527882499150286" role="link" data-timeline-entry="" class="border">' +
  '<article><div class="flex items-center gap-1">' +
  '<a href="/poteto"><img alt="@poteto" src="https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg"></a>' +
  '<div class="text-body font-bold text-primary line-clamp-1 break-all min-w-0">lauren</div>' +
  '<span class="text-body font-normal text-secondary line-clamp-1 wrap-break-word">@poteto</span>' +
  '<a href="/poteto/status/2078527882499150286">Jul 18</a></div>' +
  '<div class="text-body line-clamp-5 whitespace-pre-wrap wrap-break-word" dir="auto">' +
  '<span>organic architecture\ngood codebases have always had strong foundations.</span> ' +
  '<button>Show more</button></div>' +
  '<div class="mx-auto relative overflow-hidden"><img height="1920" width="1920" alt="" ' +
  'src="https://pbs.twimg.com/media/HNhmhvcaMAA2KyA?format=webp&amp;name=large"></div>' +
  '</article></div>';

const NESTED_MARKDOWN =
  'every team needs a gardener. someone quietly watching would engulf Show more\n\n' +
  '[![@poteto](https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg)](https://x.com/poteto)\n' +
  '[lauren](https://x.com/poteto)\n[@poteto](https://x.com/poteto)\n' +
  '[Jul 18](https://x.com/poteto/status/2078527882499150286)\n' +
  'organic architecture\ngood codebases have always had strong foundations. Show more\n' +
  '![](https://pbs.twimg.com/media/HNhmhvcaMAA2KyA?format=webp&name=large)\n' +
  '[View media](https://x.com/poteto/status/2078527882499150286/photo/1)';

describe('a post quoted inside a quoted post', () => {
  it('reads the quoted post out of the capture as a post of its own', () => {
    const posts = recoverNestedPosts(NESTED_HTML);
    expect(posts.get('2078527882499150286')).toEqual({
      url: 'https://x.com/poteto/status/2078527882499150286',
      author: 'lauren',
      handle: 'poteto',
      avatarUrl: 'https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg',
      dateLabel: 'Jul 18',
      text: 'organic architecture\ngood codebases have always had strong foundations.',
      imageUrl: 'https://pbs.twimg.com/media/HNhmhvcaMAA2KyA?format=webp&name=large',
    });
  });

  it('keeps only the outer post words in the outer post', () => {
    const out = splitNestedPost(NESTED_MARKDOWN, recoverNestedPosts(NESTED_HTML));
    expect(out.text).toBe('every team needs a gardener. someone quietly watching would engulf');
    expect(out.text).not.toContain('Show more');
    expect(out.text).not.toContain('pbs.twimg.com');
  });

  it('still reads a quoted post when the capture had no structured container', () => {
    const out = splitNestedPost(NESTED_MARKDOWN);
    expect(out.nested).toMatchObject({
      url: 'https://x.com/poteto/status/2078527882499150286',
      handle: 'poteto',
      dateLabel: 'Jul 18',
      imageUrl: 'https://pbs.twimg.com/media/HNhmhvcaMAA2KyA?format=webp&name=large',
    });
    // The flattened links and the media link are gone either way.
    expect(out.nested?.text ?? '').not.toContain('View media');
    expect(out.nested?.text ?? '').not.toContain('http');
  });
});

const OUTER_HTML =
  '<div data-href="/poteto/status/2090546476464451907" role="link" class="flex flex-col gap-3">' +
  '<div class="flex items-center gap-1"><a href="/poteto"><div class="x-avatar rounded-full size-10">' +
  '<img alt="@poteto" src="https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg"></div></a>' +
  '<div class="text-body font-bold text-primary line-clamp-1 break-all min-w-0">lauren</div>' +
  '<span aria-label="Verified account" role="button"></span>' +
  '<a href="/poteto/status/2090546476464451907">Aug 21</a></div>' +
  '<div class="text-body whitespace-pre-wrap wrap-break-word" dir="auto">' +
  '<span>every team needs a gardener.</span> <button>Show more</button></div></div>';

describe('who a quoted post is', () => {
  it('reads the avatar, the seal, the date and the truncation from the capture', () => {
    expect(recoverPostIdentities(OUTER_HTML).get('2090546476464451907')).toEqual({
      avatarUrl: 'https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg',
      verified: true,
      dateLabel: 'Aug 21',
      truncated: true,
    });
  });


  it('reads a timeline-shaped container, which names the post and not its author', () => {
    const timeline =
      '<div data-href="/i/web/status/2090546476464451907" role="link" data-timeline-entry="">' +
      '<img src="https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg">' +
      '<a href="/poteto/status/2090546476464451907">Aug 20</a>' +
      '<div class="text-body whitespace-pre-wrap wrap-break-word" dir="auto"><span>x</span></div>';
    expect(recoverPostIdentities(timeline).get('2090546476464451907')).toEqual({
      avatarUrl: 'https://pbs.twimg.com/profile_images/2093473719830315008/oo09g1Ov_normal.jpg',
      dateLabel: 'Aug 20',
    });
  });

  it('says nothing rather than guessing when the capture has no header', () => {
    expect(recoverPostIdentities('<div data-href="/u/status/1"></div>').get('1')).toEqual({});
  });
});

describe('a photo post', () => {
  it('lifts the pictures out and drops the labels the capture wrote', () => {
    const flat =
      'a card with four pictures\n\n' +
      '![](https://pbs.twimg.com/media/AAA?format=webp&name=large)\n\n' +
      '[View media](https://x.com/u/status/1/photo/1)\n\n' +
      '![](https://pbs.twimg.com/media/BBB?format=webp&name=large)\n\n' +
      '[View media](https://x.com/u/status/1/photo/2)\n\n' +
      'Show more\n\n' +
      '[Paid partnership](https://help.x.com/rules-and-policies/paid-partnerships-policy)';

    expect(extractPostMedia(flat)).toEqual({
      text: 'a card with four pictures',
      images: [
        'https://pbs.twimg.com/media/AAA?format=webp&name=large',
        'https://pbs.twimg.com/media/BBB?format=webp&name=large',
      ],
    });
  });

  it('leaves a post that has no pictures exactly as it was', () => {
    expect(extractPostMedia('just words, no pictures')).toEqual({
      text: 'just words, no pictures',
      images: [],
    });
  });
});
