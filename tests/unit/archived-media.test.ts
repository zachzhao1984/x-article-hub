import { expect, it } from 'vitest';
import { parseMarkdownToDocument } from '../../src/parser/markdown';
import { restoreArchivedMedia } from '../../src/parser/archived-media';

it('retains archived images and their route ids when rebuilding article prose', () => {
  const { document } = parseMarkdownToDocument('![Figure](https://pbs.twimg.com/media/figure.jpg)', {
    url: 'https://x.com/u/article/1', parserVersion: 10, capturedAt: '2026-10-13T00:00:00Z',
  });
  expect(document.images[0]?.r2Key).toBeNull();
  document.images.push({ imageId: 'video_1', sourceUrl: 'https://video.twimg.com/video.mp4',
    r2Key: null, status: 'video' });
  restoreArchivedMedia(document, [{ id: 'stored_image_id',
    source_url: 'https://pbs.twimg.com/media/figure.jpg',
    r2_key: 'articles/a/media/001.jpg', width: 1280, height: 720 }]);
  expect(document.images[0]).toMatchObject({ imageId: 'stored_image_id',
    r2Key: 'articles/a/media/001.jpg', status: 'ready', width: 1280, height: 720 });
  expect(document.blocks[0]).toEqual({ type: 'image', imageId: 'stored_image_id' });
  expect(document.images[1]).toMatchObject({ status: 'video', r2Key: null });
});

it('leaves images without archived bytes as fallbacks', () => {
  const { document } = parseMarkdownToDocument('![Figure](https://pbs.twimg.com/media/missing.jpg)', {
    url: 'https://x.com/u/article/1', parserVersion: 10, capturedAt: '2026-10-13T00:00:00Z',
  });
  restoreArchivedMedia(document, []);
  expect(document.images[0]).toMatchObject({ r2Key: null, status: 'external_fallback' });
});
