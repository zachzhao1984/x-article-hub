import { expect, it } from 'vitest';
import { extractEmbeddedMeta, extractEmbeddedVideo } from '../../src/parser/embedded-media';

it('selects the highest resolution source MP4 and its poster', () => {
  expect(extractEmbeddedVideo({ video: { poster: 'https://pbs.twimg.com/media/poster.jpg', variants: [
    { type: 'application/x-mpegURL', src: 'https://video.twimg.com/a.m3u8' },
    { type: 'video/mp4', src: 'https://video.twimg.com/vid/640x360/a.mp4' },
    { type: 'video/mp4', src: 'https://video.twimg.com/vid/1920x1080/a.mp4' },
  ] } })).toEqual({ videoUrl: 'https://video.twimg.com/vid/1920x1080/a.mp4', poster: 'https://pbs.twimg.com/media/poster.jpg' });
  expect(extractEmbeddedVideo({})).toBeNull();
  expect(extractEmbeddedVideo({ video: { variants: [{ type: 'video/mp4', src: 'javascript:alert(1)' }] } })).toBeNull();
});


it('normalizes syndication identity and counters for the embedded-post card', () => {
  expect(extractEmbeddedMeta({
    user: {
      name: 'Alexander Riccio',
      screen_name: 'ariccio',
      profile_image_url_https: 'https://pbs.twimg.com/profile_images/avatar.jpg',
      blue_verified: true,
    },
    created_at: '2025-09-25T12:00:00.000Z',
    conversation_count: 3,
    retweet_count: 12,
    favorite_count: 42,
    view_count: 773,
  })).toEqual({
    author: 'Alexander Riccio',
    handle: 'ariccio',
    avatarUrl: 'https://pbs.twimg.com/profile_images/avatar.jpg',
    verified: true,
    postedAt: '2025-09-25T12:00:00.000Z',
    replyCount: 3,
    repostCount: 12,
    likeCount: 42,
    viewCount: 773,
  });
});

it('rejects an avatar that is not served by X', () => {
  expect(extractEmbeddedMeta({ user: { profile_image_url_https: 'https://example.com/a.png' } }))
    .not.toHaveProperty('avatarUrl');
});
