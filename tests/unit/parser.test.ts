import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMarkdownToDocument, stripFrontmatter } from '../../src/parser/markdown';
import { countWords, documentToPlainText } from '../../src/types/article-document';

/**
 * SPEC §39 Parser acceptance, run against a real capture rather than an invented
 * one.
 *
 * tests/fixtures/x-article-2103788150405705870.md is the verbatim `/markdown`
 * output of Browser Run for
 *   https://x.com/HaibaraCrypto/article/2103788150405705870
 * SPEC §42 asks for a fixture dataset built from real captures; this is the first
 * entry in it.
 */
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../fixtures/x-article-2103788150405705870.md', import.meta.url)),
  'utf8',
);

const OPTS = {
  url: 'https://x.com/HaibaraCrypto/article/2103788150405705870',
  authorUsername: 'haibaracrypto',
  parserVersion: 1,
  capturedAt: '2026-09-30T09:08:26.905Z',
};

const parse = (markdown = FIXTURE) => parseMarkdownToDocument(markdown, OPTS);

describe('parseMarkdownToDocument — the real capture (SPEC §39)', () => {
  it('extracts the title without X branding (SPEC §9.1)', () => {
    const { document } = parse();
    expect(document.title).toBe('小白入门美股指南（建议收藏学习）');
  });

  it('extracts the author (SPEC §9.1)', () => {
    const { document } = parse();
    expect(document.author.name).toBe('灰原学姐');
    expect(document.author.username).toBe('haibaracrypto');
  });

  it('never duplicates the title as a leading heading', () => {
    const { document } = parse();
    const firstHeading = document.blocks.find((b) => b.type === 'heading');
    expect(firstHeading?.type).toBe('heading');
    // The document's own `# Title` is the title field, not a body block.
    expect(firstHeading && firstHeading.type === 'heading' ? firstHeading.text : '').not.toBe(document.title);
  });

  it('extracts paragraphs (SPEC §39)', () => {
    const { document } = parse();
    const paragraphs = document.blocks.filter((b) => b.type === 'paragraph');
    expect(paragraphs.length).toBeGreaterThan(30);
    expect(paragraphs[0]).toMatchObject({ type: 'paragraph' });
  });

  it('extracts images in document order (SPEC §9.3)', () => {
    const { document } = parse();
    expect(document.images.length).toBeGreaterThanOrEqual(10);

    const imageBlocks = document.blocks.filter((b) => b.type === 'image');
    expect(imageBlocks.length).toBe(document.images.length);
    // Order must match the order of first appearance in the source.
    expect(imageBlocks.map((b) => (b.type === 'image' ? b.imageId : ''))).toEqual(
      document.images.map((i) => i.imageId),
    );
    expect(document.images.every((i) => i.sourceUrl.startsWith('https://pbs.twimg.com/'))).toBe(true);
  });

  it('marks images external_fallback until media download runs (SPEC §10)', () => {
    const { document } = parse();
    expect(document.images.every((i) => i.status === 'external_fallback' && i.r2Key === null)).toBe(true);
  });

  it('extracts links (SPEC §39)', () => {
    const { document } = parse();
    expect(document.links.length).toBeGreaterThan(0);
    const media = document.links.find((l) => l.href.includes('/media/'));
    expect(media?.href).toMatch(/^https:\/\/x\.com\//);
  });

  it('gives images stable ids derived from their URL (SPEC §36)', () => {
    const a = parse(FIXTURE).document;
    const b = parse(FIXTURE).document;
    expect(a.images.map((i) => i.imageId)).toEqual(b.images.map((i) => i.imageId));
    expect(new Set(a.images.map((i) => i.imageId)).size).toBe(a.images.length);
  });

  it('emits no warnings on a healthy capture', () => {
    expect(parse().warnings).toEqual([]);
  });

  it('round-trips into plain text with no markup (SPEC §13.4)', () => {
    const { document } = parse();
    const text = documentToPlainText(document);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toMatch(/!\[/);
    expect(countWords(text)).toBeGreaterThan(1000);
  });
});

describe('structure preservation (SPEC §9.3)', () => {
  it('preserves heading levels and clamps anything deeper than 3 (SPEC §9.2)', () => {
    const { document } = parse();
    const levels = document.blocks.filter((b) => b.type === 'heading').map((b) => (b.type === 'heading' ? b.level : 0));

    expect(levels).toContain(2);
    expect(levels).toContain(3);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...levels)).toBeLessThanOrEqual(3);
  });

  it('groups consecutive ordered items into a single list block', () => {
    const { document } = parse();
    const lists = document.blocks.filter((b) => b.type === 'list');
    expect(lists.length).toBeGreaterThan(0);

    const tenSteps = lists.find((b) => b.type === 'list' && b.ordered && b.items.length >= 9);
    expect(tenSteps).toBeDefined();
  });

  it('keeps ordered and unordered lists distinct', () => {
    const { document } = parse();
    const lists = document.blocks.filter((b) => b.type === 'list');
    expect(lists.some((b) => b.type === 'list' && b.ordered)).toBe(true);
    expect(lists.some((b) => b.type === 'list' && !b.ordered)).toBe(true);
  });

  it('preserves the quote', () => {
    const { document } = parse();
    const quotes = document.blocks.filter((b) => b.type === 'quote');
    expect(quotes.length).toBeGreaterThanOrEqual(1);
    expect(quotes[0]).toMatchObject({ type: 'quote' });
  });

  it('does not rewrite the author prose (SPEC §9.3)', () => {
    const { document } = parse();
    const source = stripFrontmatter(FIXTURE);
    // Spot-check a distinctive sentence survives verbatim.
    const paragraph = document.blocks.find(
      (b) => b.type === 'paragraph' && b.text.includes('换了一个软件下注'),
    );
    expect(paragraph).toBeDefined();
    expect(source).toContain('换了一个软件下注');
  });
});

describe('synthetic edge cases', () => {
  it('preserves fenced code blocks with a language (SPEC §9.2)', () => {
    const md = '---\ntitle: "T"\n---\n\nIntro.\n\n```python\ndef f():\n    return 1\n```\n\nAfter.';
    const { document } = parseMarkdownToDocument(md, { ...OPTS, url: 'https://x.com/u/article/1' });

    const code = document.blocks.find((b) => b.type === 'code');
    expect(code).toMatchObject({ type: 'code', language: 'python' });
    expect(code && code.type === 'code' ? code.code : '').toBe('def f():\n    return 1');
  });

  it('joins soft-wrapped lines into one paragraph', () => {
    const md = '---\ntitle: "T"\n---\n\nThis is one\nparagraph wrapped\nacross lines.';
    const { document } = parseMarkdownToDocument(md, { ...OPTS, url: 'https://x.com/u/article/1' });
    const paragraphs = document.blocks.filter((b) => b.type === 'paragraph');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toMatchObject({ text: 'This is one paragraph wrapped across lines.' });
  });

  it('falls back to the username when the capture has no author', () => {
    const md = '---\ntitle: "T"\n---\n\nBody.';
    const { document } = parseMarkdownToDocument(md, { ...OPTS, url: 'https://x.com/someone/article/9' });
    expect(document.author.username).toBe('someone');
    expect(document.author.name).toBe('someone');
  });

  it('flags an empty capture instead of producing an empty document', () => {
    const { document, warnings } = parseMarkdownToDocument('---\ntitle: "T"\n---\n', OPTS);
    expect(warnings.some((w) => w.includes('No blocks'))).toBe(true);
    expect(document.blocks).toEqual([]);
  });

  it('never drops list content when nesting is flattened', () => {
    const md = '---\ntitle: "T"\n---\n\n1. Parent\n   - Child\n2. Second';
    const { document, warnings } = parseMarkdownToDocument(md, { ...OPTS, url: 'https://x.com/u/article/1' });
    const list = document.blocks.find((b) => b.type === 'list');
    expect(list && list.type === 'list' ? list.items.length : 0).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.includes('flattened'))).toBe(true);
  });
});
