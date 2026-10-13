import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseMarkdownToDocument } from '../../src/parser/markdown';

/**
 * Videos in an imported Article.
 *
 * The pipeline archives images. It does not archive videos and never has — `video` appears
 * nowhere in the spec — but until this change it *tried*, and the failure was worse than
 * not trying.
 *
 * `addImage` accepted any URL, so `![](…mp4)` became a `media_objects` row. The media
 * pipeline rejected it at the content-type gate as `INVALID_CONTENT_TYPE`, permanently, and
 * the reading page then rendered:
 *
 *   Image not archived
 *   this figure still loads from x.com and may stop working
 *
 * That sentence is written for an image whose download failed. Said about a video it is
 * false twice over: nothing was archived because nothing was ever fetched, and nothing is
 * going to break. Worse, it sat inside a `<figure>` that reserves a box from stored
 * dimensions, so the reader got a broken-looking image slot instead of the recording.
 *
 * These tests are about the *classification*, run through the real parser rather than
 * asserted against source text, because the bug was a classification bug: the parser
 * decided a video was an image and everything downstream believed it.
 */

const OPTS = {
  url: 'https://x.com/example/article/1234567890',
  authorUsername: 'example',
  parserVersion: 1,
  capturedAt: '2026-10-08T00:00:00.000Z',
};

/** A minimal document with frontmatter, one body line. */
const withBody = (body: string) =>
  [
    '---',
    'title: "A post with media"',
    'author: Example',
    'username: example',
    '---',
    '',
    body,
    '',
  ].join('\n');

const parse = (body: string) => parseMarkdownToDocument(withBody(body), OPTS);

const firstImage = (body: string) => parse(body).document.images[0];

describe('a video in the body', () => {
  it('is classified as a video, not as an image', () => {
    const img = firstImage('![](https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/abc.mp4)');
    expect(img).toBeDefined();
    expect(img!.status).toBe('video');
  });

  it('is still a block, so the reader is told about it', () => {
    // The alternative would be to drop it. That is worse: a video missing from the body
    // with no trace is the one failure a reader cannot detect.
    const { document } = parse('![](https://video.twimg.com/x/abc.mp4)');
    const imageBlocks = document.blocks.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(1);
  });

  it('keeps the original URL, because that is the whole point', () => {
    // Nothing is archived to point at instead, so the URL has to survive intact — including
    // its query string, which X's player URLs carry.
    const url = 'https://video.twimg.com/amplify_video/999/vid/1280x720/xyz.mp4?tag=14';
    const img = firstImage(`![](${url})`);
    expect(img!.status).toBe('video');
    expect(img!.sourceUrl).toBe(url);
  });

  it('is recognized by host even without a container extension', () => {
    // X's player URLs do not always end in `.mp4`; the host is the reliable signal.
    const img = firstImage('![](https://video.twimg.com/ext_tw_video/456/pu/vid/playlist.m3u8)');
    expect(img!.status).toBe('video');
  });

  it.each([
    ['https://video.twimg.com/a/b.mp4', 'the video CDN host'],
    ['https://video.twimg.com/a/b', 'the host with no extension'],
    ['https://video.twitter.com/a/b.mp4', 'the legacy host'],
    ['https://cdn.example.com/clip.mp4', 'a container extension off-host'],
    ['https://example.com/clip.webm?x=1', 'a webm with a query string'],
    ['https://example.com/clip.MOV', 'an uppercase extension'],
  ])('treats %s as a video (%s)', (url) => {
    expect(firstImage(`![](${url})`)!.status).toBe('video');
  });

  it.each([
    ['https://pbs.twimg.com/media/abc.jpg', 'a normal image'],
    ['https://pbs.twimg.com/media/abc.png', 'a png'],
    ['https://example.com/photo.webp', 'a webp'],
    ['https://example.com/animated.gif', 'a gif — the one thing that does move and is archived'],
    // The narrowness matters: a false positive here turns a real image into a link, which
    // loses the image. `.mp4` inside a path segment, with no extension at the end, is not
    // a container.
    ['https://example.com/mp4/photo.jpg', 'mp4 as a directory name'],
    ['https://example.com/photo.mp4.jpg', 'mp4 mid-filename'],
  ])('leaves %s as an image (%s)', (url) => {
    const img = firstImage(`![](${url})`);
    expect(img!.status).not.toBe('video');
    // Still the pre-pipeline state, which is what makes the media run pick it up.
    expect(img!.status).toBe('external_fallback');
  });

  it('does not confuse an image linked from a video page', () => {
    // `[![](thumb.jpg)](https://x.com/…/status/…/video/1)` — X wraps a poster frame in a
    // link to the post. The src is the image and the href is the status permalink, and the
    // src is what decides.
    const img = firstImage('[![](https://pbs.twimg.com/thumb.jpg)](https://x.com/example/status/1/video/1)');
    expect(img!.status).toBe('external_fallback');
  });
});

describe('the media pipeline and the reader agree about videos', () => {
  const media = readFileSync(resolve('src/services/media.ts'), 'utf8');
  const page = readFileSync(resolve('src/pages/article/[slug].astro'), 'utf8');
  const types = readFileSync(resolve('src/types/article-document.ts'), 'utf8');
  const css = readFileSync(resolve('public/site.css'), 'utf8');

  /** Source with its comments stripped, so an assertion is about code and not about prose. */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\*.*$/gm, '');

  it('keeps videos out of the media work list', () => {
    // The row was the harm: registering it produced a permanent INVALID_CONTENT_TYPE, a
    // failed attempt and a warning about something nobody had asked the pipeline to fetch.
    // Excluding it means no row, no attempt, no warning — the honest record.
    const filter = /const bodyImages = document\.images\.filter\(([\s\S]*?)\);/.exec(media)?.[1] ?? '';
    expect(filter, 'cannot locate the media work list').not.toBe('');
    expect(filter).toMatch(/img\.status !== 'video'/);
    // `ready` is the idempotence guard and must still be there.
    expect(filter).toMatch(/img\.status !== 'ready'/);
  });

  it('renders a video as a link to X, before the failed-image branch', () => {
    // Order is the mechanism: the "Image not archived" branch is the default for anything
    // without an r2Key, so a video reaching it gets the false explanation. The video branch
    // has to come first.
    //
    // Located by the `fig-missing` class and not by the phrase it renders. The phrase also
    // appears in the comment above the video branch explaining why it is needed, so matching
    // the text put the "failed image branch" *before* the video branch. The class exists in
    // exactly one place: the rendered anchor.
    const src = readFileSync(resolve('src/pages/article/[slug].astro'), 'utf8');
    const videoAt = src.indexOf("img.status === 'video'");
    const fallbackAt = src.indexOf('class="fig-missing"');
    expect(videoAt).toBeGreaterThanOrEqual(0);
    expect(fallbackAt, 'cannot locate the failed-image branch').toBeGreaterThan(0);
    expect(videoAt, 'the video branch must come before the failed-image figure').toBeLessThan(fallbackAt);

    // The branch's own `return`, so the assertions below are about what it renders and not
    // about the comment above it — an earlier version sliced from the branch to the fallback
    // and picked up the figure's `/media/` from the *next* branch, which is a false failure
    // caused by the stripper rather than by the code.
    const returned = /if \(img\.status === 'video'\) \{[\s\S]*?return \(([\s\S]*?)\);\s*\}/
      .exec(src)?.[1] ?? '';
    expect(returned, 'cannot locate the video branch return').not.toBe('');

    expect(returned).toMatch(/href=\{img\.sourceUrl\}/);
    expect(returned).toMatch(/<video[\s\S]*?src=\{img\.sourceUrl\}/);
    expect(returned).toMatch(/controls/);
    expect(returned).toMatch(/playsinline/);
    expect(returned).toMatch(/preload="metadata"/);
    expect(returned).not.toMatch(/\/media\//);
    // `nofollow`, like the original-link chain: this page should not pass authority out.
    expect(returned).toMatch(/rel="noopener noreferrer nofollow"/);
    // No `<figure>` — no reserved box for dimensions nothing knows.
    expect(returned).not.toMatch(/<figure/);
  });

  it('says the recording is elsewhere rather than claiming a failure', () => {
    // The words matter. The old copy asserted the figure "still loads from x.com", which
    // for a video was the opposite of what was happening.
    const videoAt = page.indexOf("img.status === 'video'");
    const branch = page.slice(videoAt, videoAt + 1600);
    expect(branch).toMatch(/Watch the video on x\.com/);
    expect(branch).toMatch(/not archived here/);
    // Not the failed-image sentence.
    expect(branch).not.toMatch(/still loads from x\.com/);
    // And no `<figure>` — no reserved box for dimensions nothing knows.
    expect(branch).not.toMatch(/<figure/);
  });

  it('does not reserve a box for a link', () => {
    // A `<figure>` with dimensions is what made the old treatment read as a broken picture.
    expect(css).toMatch(/\.fig-video/);
    expect(css).not.toMatch(/\.fig-video \{[^}]*height/);
  });

  it('declares the status in the type, so the union cannot drift', () => {
    expect(types).toMatch(/status: 'ready' \| 'failed' \| 'external_fallback' \| 'video'/);
  });
});
