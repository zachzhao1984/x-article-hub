import { expect, it } from 'vitest';
import { recoverVideoLinks } from '../../src/parser/video';
import { parseMarkdownToDocument } from '../../src/parser/markdown';

it('recovers the video omitted by Markdown at its original paragraph position', () => {
  const { document } = parseMarkdownToDocument('Intro.\n\n## Update Notes\n\nBody.', {
    url: 'https://x.com/mafiagame/article/1', parserVersion: 9,
    capturedAt: '2026-10-12T00:00:00Z',
  });
  const html = '<p>Intro.</p><figure><video src="https://video.twimg.com/trailer.mp4?tag=29&amp;x=1"></video>' +
    '<figcaption>Launch Trailer</figcaption></figure><h2>Update Notes</h2>';
  expect(recoverVideoLinks(document, html)).toBe(1);
  expect(document.blocks[1]).toEqual({ type: 'image', imageId: 'video_0' });
  expect(document.images[0]).toMatchObject({ status: 'video', r2Key: null,
    sourceUrl: 'https://video.twimg.com/trailer.mp4?tag=29&x=1', altText: 'Launch Trailer' });
  expect(recoverVideoLinks(document, html)).toBe(0);
  expect(recoverVideoLinks(document, '<video src="javascript:alert(1)"></video>')).toBe(0);
});
