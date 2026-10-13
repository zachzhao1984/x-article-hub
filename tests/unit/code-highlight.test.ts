import { expect, it } from 'vitest';
import { highlightCode } from '../../src/lib/code-highlight';
import { parseMarkdownToDocument } from '../../src/parser/markdown';

it('highlights JavaScript with both themes and safely escapes code', async () => {
  const html = await highlightCode('const message = "<script>";', 'javascript');
  expect(html).toContain('shiki');
  expect(html).toContain('--shiki-dark');
  expect(html).not.toContain('<script>');
  expect(await highlightCode('hello <world>', 'unknown')).toContain('&#x3C;world>');
});

it('moves an exported language chip into the following code block', () => {
  const { document } = parseMarkdownToDocument('Intro.\n\njavascript\n\n```\nconst x = 1;\n```', {
    url: 'https://x.com/u/article/1', parserVersion: 16, capturedAt: '2026-10-13',
  });
  expect(document.blocks).toHaveLength(2);
  expect(document.blocks[1]).toEqual({ type: 'code', language: 'javascript', code: 'const x = 1;' });
});
