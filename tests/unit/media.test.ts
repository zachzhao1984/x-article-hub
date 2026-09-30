import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../../src/lib/image-size';
import { sniffImageType } from '../../src/services/media';
import { R2_PATHS } from '../../src/types/article-document';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function asciiBytes(text: string, padTo = 0): Uint8Array {
  const out = new Uint8Array(Math.max(text.length, padTo));
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

describe('sniffImageType (SPEC §10 content-type check)', () => {
  it('recognises the formats X actually serves', () => {
    // WebP: RIFF....WEBP
    const webp = asciiBytes('RIFF', 12);
    for (let i = 0; i < 4; i += 1) webp[8 + i] = 'WEBP'.charCodeAt(i);
    expect(sniffImageType(webp)).toMatchObject({ format: 'webp', extension: 'webp' });

    // PNG
    const png = new Uint8Array(16);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(sniffImageType(png)).toMatchObject({ format: 'png', extension: 'png' });

    // GIF
    expect(sniffImageType(asciiBytes('GIF89a'))).toMatchObject({ format: 'gif', extension: 'gif' });

    // JPEG
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ format: 'jpeg', extension: 'jpg' });
  });

  it('rejects bytes that are not an image at all', () => {
    // An HTML error page served as image/jpeg. The content-type header is a claim
    // by the origin; trusting it would archive a web page as an image and let it
    // fail in the reader's browser instead of in the pipeline.
    const html = asciiBytes('<!DOCTYPE html><html><body>404 Not Found</body></html>');
    expect(sniffImageType(html)).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(asciiBytes('RIFF', 12))).toBeNull();
  });
});

describe('imageDimensions (SPEC §10 width/height)', () => {
  it('reads PNG dimensions from IHDR', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // width 1200, height 675, big-endian at offsets 16 and 20.
    png[16] = 0; png[17] = 0; png[18] = 0x04; png[19] = 0xb0;
    png[20] = 0; png[21] = 0; png[22] = 0x02; png[23] = 0xa3;
    expect(imageDimensions(png, 'png')).toEqual({ width: 1200, height: 675 });
  });

  it('reads GIF dimensions from the screen descriptor', () => {
    const gif = new Uint8Array(13);
    for (let i = 0; i < 6; i += 1) gif[i] = 'GIF89a'.charCodeAt(i);
    gif[6] = 0x20; gif[7] = 0x00;   // 32 wide, little-endian
    gif[8] = 0x10; gif[9] = 0x00;   // 16 tall
    expect(imageDimensions(gif, 'gif')).toEqual({ width: 32, height: 16 });
  });

  it('reads JPEG dimensions by walking to the frame header', () => {
    // SOI, a JFIF APP0 segment, then SOF0 carrying 300x200.
    const jpeg = new Uint8Array([
      0xff, 0xd8,             // SOI
      0xff, 0xe0, 0x00, 0x10, // APP0, length 16
      0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, // SOF0, length 17
      0x08,                   // 8-bit components
      0x00, 0xc8,             // height 200
      0x01, 0x2c,             // width 300
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(jpeg, 'jpeg')).toEqual({ width: 300, height: 200 });
  });

  it('skips JPEG markers that are not frame headers', () => {
    // A DHT (0xc4) before the SOF0. Mistaking it for a frame header would return
    // the Huffman table's bytes as dimensions.
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x04, 0x01, 0x00, // DHT, minimal
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x00, 0x64, 0x03,
    ]);
    expect(imageDimensions(jpeg, 'jpeg')).toEqual({ width: 100, height: 300 });
  });

  it('reads WebP dimensions from a VP8X canvas', () => {
    const webp = new Uint8Array(40);
    for (let i = 0; i < 4; i += 1) webp[i] = 'RIFF'.charCodeAt(i);
    for (let i = 0; i < 4; i += 1) webp[8 + i] = 'WEBP'.charCodeAt(i);
    for (let i = 0; i < 4; i += 1) webp[12 + i] = 'VP8X'.charCodeAt(i);
    // 24-bit little-endian, stored minus one: 1200-1 = 1199 = 0x04AF.
    webp[24] = 0xaf; webp[25] = 0x04; webp[26] = 0x00;   // 1200
    webp[27] = 0xa2; webp[28] = 0x02; webp[29] = 0x00;   // 675 (674 = 0x02A2)
    expect(imageDimensions(webp, 'webp')).toEqual({ width: 1200, height: 675 });
  });

  it('returns null rather than guessing', () => {
    // A wrong dimension is worse than a missing one: a missing one can be laid
    // out after load, a wrong one cannot.
    expect(imageDimensions(new Uint8Array(4), 'jpeg')).toBeNull();
    expect(imageDimensions(asciiBytes('not an image at all!!'), 'png')).toBeNull();
    // A JPEG with no frame header before the scan starts.
    const scanOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00]);
    expect(imageDimensions(scanOnly, 'jpeg')).toBeNull();
  });

  it('cannot be made to throw or hang on truncated input', () => {
    // These read bytes fetched from a third party, so an out-of-range read has to
    // be a quiet null. A JPEG segment length of 0 would otherwise spin forever.
    for (let len = 0; len < 40; len += 1) {
      const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x00]).subarray(0, len);
      expect(() => imageDimensions(truncated, 'jpeg')).not.toThrow();
      expect(() => imageDimensions(new Uint8Array(len), 'webp')).not.toThrow();
      expect(() => imageDimensions(new Uint8Array(len), 'gif')).not.toThrow();
      expect(() => imageDimensions(new Uint8Array(len), 'png')).not.toThrow();
    }
  });
});

describe('R2 media keys (SPEC §8 / §10)', () => {
  it('pads the position to three digits so keys sort as numbers', () => {
    expect(R2_PATHS.media('art_1', 1, 'webp')).toBe('articles/art_1/media/001.webp');
    expect(R2_PATHS.media('art_1', 42, 'jpg')).toBe('articles/art_1/media/042.jpg');
    expect(R2_PATHS.media('art_1', 100, 'png')).toBe('articles/art_1/media/100.png');
  });

  it('names the key after the sniffed format, not a hardcoded .webp', () => {
    // A `.webp` key holding JPEG bytes would make /media serve the wrong content
    // type, so the extension follows what was actually stored.
    const sniffed = sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0));
    expect(R2_PATHS.media('art_1', 7, sniffed!.extension)).toBe('articles/art_1/media/007.jpg');
  });

  it('gives the avatar its own key so it never takes a body ordinal', () => {
    expect(R2_PATHS.avatar('art_1', 'webp')).toBe('articles/art_1/media/avatar.webp');
  });

  it('names the avatar key after its sniffed format, like every other key', () => {
    // X serves the profile_images avatar as JPEG, so a hardcoded `.webp` wrote
    // JPEG bytes under a WebP name. The page still rendered because /media serves
    // the content type from D1, which is exactly why the lie went unnoticed — and
    // why a key that misdescribes its contents has to be impossible by construction.
    const jpegAvatar = R2_PATHS.avatar('art_1', sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))!.extension);
    expect(jpegAvatar).toBe('articles/art_1/media/avatar.jpg');
    expect(jpegAvatar).not.toBe(R2_PATHS.avatar('art_1', 'webp'));
  });
});

describe('image id scoping (SPEC §10 PRIMARY KEY)', () => {
  it('is unique per article, so two Articles can share an image URL', async () => {
    // The failure this guards against: image ids hashed the source URL alone, so
    // the same image in two Articles produced the same id — and media_objects
    // uses the id as its PRIMARY KEY. The second article's media run died with
    // `UNIQUE constraint failed: media_objects.id`, which is how it was found.
    const { parseMarkdownToDocument } = await import('../../src/parser/markdown');
    const markdown = [
      '---',
      'title: Same image twice',
      'author: Someone',
      '---',
      '',
      '![shared](https://pbs.twimg.com/media/Shared123.jpg)',
      '',
      'Body text.',
    ].join('\n');

    const first = parseMarkdownToDocument(markdown, {
      url: 'https://x.com/alpha/article/111',
      parserVersion: 5,
      capturedAt: '2026-09-30T00:00:00.000Z',
    });
    const second = parseMarkdownToDocument(markdown, {
      url: 'https://x.com/beta/article/222',
      parserVersion: 5,
      capturedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(first.document.images[0]?.imageId).not.toBe(second.document.images[0]?.imageId);
  });

  it('is stable across a re-parse of the same article', async () => {
    // SPEC §27 — re-parsing must be able to find the bytes an earlier run already
    // downloaded. An id that changed on every parse would orphan them.
    const { parseMarkdownToDocument } = await import('../../src/parser/markdown');
    const markdown = ['---', 'title: T', 'author: A', '---', '', '![x](https://pbs.twimg.com/media/A.jpg)'].join(
      '\n',
    );
    const opts = {
      url: 'https://x.com/alpha/article/111',
      parserVersion: 5,
      capturedAt: '2026-09-30T00:00:00.000Z',
    };
    const a = parseMarkdownToDocument(markdown, opts).document.images[0]?.imageId;
    const b = parseMarkdownToDocument(markdown, opts).document.images[0]?.imageId;
    expect(a).toBe(b);
  });
});

describe('avatar image id (SPEC §10 PRIMARY KEY)', () => {
  it('is scoped per article, so one author posting many articles does not collide', async () => {
    // Same trap as the body-image ids, and found the same way: an author with
    // several articles has one avatar URL, media_objects.id is the PRIMARY KEY,
    // and the second article's avatar row failed to insert.
    const { avatarImageId } = await import('../../src/services/media');
    const url = 'https://pbs.twimg.com/profile_images/123/abc_normal.jpg';
    expect(avatarImageId('art_one', url)).not.toBe(avatarImageId('art_two', url));
    // Stable within an article, or the byline avatar would re-download forever.
    expect(avatarImageId('art_one', url)).toBe(avatarImageId('art_one', url));
  });
});

describe('R2 key honesty (SPEC §8 / §10)', () => {
  it('never writes bytes under a key that misdescribes them', async () => {
    // Every key the pipeline can produce is derived from a sniffed format, so the
    // invariant is checkable per format rather than per call site. The avatar was
    // the one that broke it: a hardcoded `.webp` holding JPEG, which rendered fine
    // because /media serves the content type from D1 — the lie was invisible.
    const { R2_PATHS } = await import('../../src/types/article-document');
    const cases: Array<[number[], string, string]> = [
      [[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'jpg'],
      [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png', 'png'],
      [[...Array.from(asciiBytes('GIF89a'))], 'image/gif', 'gif'],
    ];

    for (const [header, mime, extension] of cases) {
      const sniffed = sniffImageType(new Uint8Array(header))!;
      expect(sniffed.mime).toBe(mime);
      expect(R2_PATHS.media('art_1', 1, sniffed.extension)).toBe(`articles/art_1/media/001.${extension}`);
      expect(R2_PATHS.avatar('art_1', sniffed.extension)).toBe(`articles/art_1/media/avatar.${extension}`);
    }
  });

  it('derives the expected key from content type, so a rename is detectable', async () => {
    // The sweep can only reclaim a renamed key because the expected key is a pure
    // function of the row. If the two ever stopped agreeing, a re-run would keep
    // re-downloading the same image forever instead of settling.
    const { R2_PATHS } = await import('../../src/types/article-document');
    expect(R2_PATHS.avatar('art_1', 'jpg')).not.toBe(R2_PATHS.avatar('art_1', 'webp'));
    expect(R2_PATHS.media('art_1', 3, 'jpg')).not.toBe(R2_PATHS.media('art_1', 4, 'jpg'));
  });
});
