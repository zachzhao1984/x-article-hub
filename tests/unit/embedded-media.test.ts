import { expect, it } from 'vitest';
import { extractEmbeddedVideo } from '../../src/parser/embedded-media';

it('selects the highest resolution source MP4 and its poster', () => {
  expect(extractEmbeddedVideo({ video: { poster: 'https://pbs.twimg.com/media/poster.jpg', variants: [
    { type: 'application/x-mpegURL', src: 'https://video.twimg.com/a.m3u8' },
    { type: 'video/mp4', src: 'https://video.twimg.com/vid/640x360/a.mp4' },
    { type: 'video/mp4', src: 'https://video.twimg.com/vid/1920x1080/a.mp4' },
  ] } })).toEqual({ videoUrl: 'https://video.twimg.com/vid/1920x1080/a.mp4', poster: 'https://pbs.twimg.com/media/poster.jpg' });
  expect(extractEmbeddedVideo({})).toBeNull();
  expect(extractEmbeddedVideo({ video: { variants: [{ type: 'video/mp4', src: 'javascript:alert(1)' }] } })).toBeNull();
});
