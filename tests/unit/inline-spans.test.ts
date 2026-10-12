import { describe, expect, it } from 'vitest';
import { parseMarkdownToDocument } from '../../src/parser/markdown';
import { inlineToText } from '../../src/types/article-document';

/**
 * SPEC §9.3 — inline Markdown becomes typed spans.
 *
 * ## The bug this exists for
 *
 * The parser handled links and bare URLs and nothing else, so `**bold**` reached the reading
 * page as literal asterisks. Measured on production: every sampled article carried between 11
 * and 45 literal `**` pairs on the page. The reading page renders the document, not the
 * Markdown, so a block's text has to be interpreted rather than passed through — and the
 * emphasis has to survive as structure, because SPEC §9.3 says the parser preserves the
 * author's intent rather than flattening it.
 *
 * ## Why these assert on spans and not on a string
 *
 * The previous shape made the bug invisible: a test that read `block.text` could not tell a
 * rendering instruction from prose, because both were the same string. Asserting the span
 * types is what makes "the marker was interpreted" a fact the test can state.
 */

/** Parse a body and return the blocks, so each case is one line of markdown. */
function blocks(md: string) {
  const { document } = parseMarkdownToDocument(`---\ntitle: "T"\n---\n\n${md}`, {
    url: 'https://x.com/u/article/1',
    authorName: 'A',
    authorUsername: 'u',
    publishedAt: null,
    parserVersion: 7,
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
  return document.blocks;
}

function firstParagraph(md: string) {
  const p = blocks(md).find((b) => b.type === 'paragraph');
  if (!p || p.type !== 'paragraph') throw new Error(`no paragraph in: ${md}`);
  return p.spans;
}

describe('inline spans', () => {
  it('turns **bold** into a strong span, not literal asterisks', () => {
    const spans = firstParagraph('This is **bold** text.');
    expect(spans).toEqual([
      { type: 'text', text: 'This is ' },
      { type: 'strong', text: 'bold' },
      { type: 'text', text: ' text.' },
    ]);
    // And the markers are gone from the words, which is what the page renders.
    expect(inlineToText(spans)).toBe('This is bold text.');
  });

  it('turns *italic* into an em span', () => {
    expect(firstParagraph('An *emphasised* word.')).toEqual([
      { type: 'text', text: 'An ' },
      { type: 'em', text: 'emphasised' },
      { type: 'text', text: ' word.' },
    ]);
  });

  it('turns a link into a link span that keeps its target', () => {
    // The old `inline()` recorded the href in `document.links` and dropped it from the text,
    // so a linked phrase rendered as ordinary unclickable words.
    expect(firstParagraph('Read [the docs](https://example.com/docs) now.')).toEqual([
      { type: 'text', text: 'Read ' },
      { type: 'link', text: 'the docs', href: 'https://example.com/docs' },
      { type: 'text', text: ' now.' },
    ]);
  });

  it('turns `code` into a code span and leaves its contents alone', () => {
    // A backtick span is literal: an author writing `**not bold**` inside backticks means the
    // asterisks as characters.
    expect(firstParagraph('Use `**not bold**` here.')).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'code', text: '**not bold**' },
      { type: 'text', text: ' here.' },
    ]);
  });

  it('handles several constructs in one paragraph', () => {
    const spans = firstParagraph('**A** then *b* then [c](https://e.com) then `d`.');
    const types = spans.map((s) => s.type);
    expect(types).toContain('strong');
    expect(types).toContain('em');
    expect(types).toContain('link');
    expect(types).toContain('code');
  });

  it('leaves a lone asterisk as text, so arithmetic is not emphasis', () => {
    // `2 * 3 * 4` must not become one emphasis run swallowing the multiplication.
    const spans = firstParagraph('2 * 3 * 4 is twelve.');
    expect(spans).toEqual([{ type: 'text', text: '2 * 3 * 4 is twelve.' }]);
  });

  it('merges adjacent plain runs', () => {
    // A paragraph should arrive as a few spans, not one per word: the page renders a node per
    // span. This is the assertion that keeps that true.
    const spans = firstParagraph('Plain words with no markup at all in this sentence.');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.type).toBe('text');
  });

  it('applies to headings, quotes and list items, not only paragraphs', () => {
    // Every text-bearing block goes through the same function; a fix that only covered
    // paragraphs would leave the bug in place for the other three.
    const heading = blocks('## A **bold** heading').find((b) => b.type === 'heading');
    expect(heading && heading.type === 'heading' ? heading.spans.some((s) => s.type === 'strong') : false).toBe(true);

    const quote = blocks('> A **bold** quote').find((b) => b.type === 'quote');
    expect(quote && quote.type === 'quote' ? quote.spans.some((s) => s.type === 'strong') : false).toBe(true);

    const list = blocks('- A **bold** item').find((b) => b.type === 'list');
    const item = list && list.type === 'list' ? list.items[0] : undefined;
    expect(item?.some((s) => s.type === 'strong')).toBe(true);
  });

  it('keeps the plain text recoverable for search and word counts', () => {
    // FTS indexes this and the word count counts it, so the markers must not reappear and the
    // words must not be lost.
    const spans = firstParagraph('A **bold** and *emphasised* sentence.');
    expect(inlineToText(spans)).toBe('A bold and emphasised sentence.');
  });

  it('still records every link target in document.links', () => {
    // The change moved where the href is rendered, not whether the article's targets are
    // recorded — that list is unchanged and still what the archive reports.
    const { document } = parseMarkdownToDocument(
      `---\ntitle: "T"\n---\n\nRead [the docs](https://example.com/docs) and https://other.example/page`,
      {
        url: 'https://x.com/u/article/1',
        authorName: 'A',
        authorUsername: 'u',
        publishedAt: null,
        parserVersion: 7,
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    const hrefs = document.links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/docs');
    expect(hrefs).toContain('https://other.example/page');
  });
});
