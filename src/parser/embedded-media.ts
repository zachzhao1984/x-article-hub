import type { ArticleDocument } from '../types/article-document';

export function extractEmbeddedVideo(data: unknown): { videoUrl: string; poster?: string } | null {
  const video = (data as { video?: { poster?: string; variants?: Array<{ type: string; src: string }> } })?.video;
  const variants = video?.variants?.filter(v => v.type === 'video/mp4' && /^https:\/\/video\.twimg\.com\//.test(v.src)) ?? [];
  const area = (url: string): number => {
    const match = /\/(\d+)x(\d+)\//.exec(url);
    return match ? Number(match[1]) * Number(match[2]) : 0;
  };
  variants.sort((a, b) => area(b.src) - area(a.src));
  if (!variants[0]) return null;
  return { videoUrl: variants[0].src,
    ...(video?.poster && /^https:\/\/pbs\.twimg\.com\//.test(video.poster) ? { poster: video.poster } : {}) };
}

type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord =>
  typeof value === 'object' && value !== null ? (value as LooseRecord) : {};

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Normalize the two upstreams into the fields the embedded-post card renders. */
export function extractEmbeddedMeta(data: unknown): Record<string, unknown> {
  const root = asRecord(data);
  const tweet = asRecord(root.tweet);
  const source = Object.keys(tweet).length ? tweet : root;
  const user = asRecord(source.user ?? tweet.user ?? root.user);
  const media = asRecord(source.media ?? tweet.media ?? root.media);

  const avatar = asText(user.profile_image_url_https ?? user.avatar_url ?? user.profile_image_url);
  const meta: Record<string, unknown> = {};

  if (asText(user.name)) meta.author = asText(user.name);
  if (asText(user.screen_name)) meta.handle = asText(user.screen_name);
  if (avatar && /^https:\/\/(pbs|abs)\.twimg\.com\//.test(avatar)) meta.avatarUrl = avatar;
  if (typeof (user.blue_verified ?? user.verified) === 'boolean') {
    meta.verified = Boolean(user.blue_verified ?? user.verified);
  }
  if (asText(source.created_at)) meta.postedAt = asText(source.created_at);

  const replies = asNumber(source.conversation_count ?? source.reply_count ?? media.replies);
  const reposts = asNumber(source.retweet_count ?? source.repost_count ?? media.retweets);
  const likes = asNumber(source.favorite_count ?? source.like_count ?? media.likes);
  const views = asNumber(source.view_count ?? media.views);
  if (replies !== undefined) meta.replyCount = replies;
  if (reposts !== undefined) meta.repostCount = reposts;
  if (likes !== undefined) meta.likeCount = likes;
  if (views !== undefined) meta.viewCount = views;

  return meta;
}

/** Apply both halves of a syndication payload: the tweet's identity and its video. */
function applyEmbeddedPayload(block: Extract<ArticleDocument['blocks'][number], { type: 'embed' }>, payload: unknown): void {
  const media = extractEmbeddedVideo(payload);
  if (media) Object.assign(block, media);
  const meta = extractEmbeddedMeta(payload);
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) Object.assign(block, { [key]: value });
  }
}

export async function enrichEmbeddedMedia(document: ArticleDocument, bucket?: R2Bucket): Promise<void> {
  for (const block of document.blocks) {
    if (block.type !== 'embed') continue;

    const key = `embedded-posts/${block.postId}/media.json`;
    try {
      const cached = await bucket?.get(key);
      if (cached) applyEmbeddedPayload(block, await cached.json());

      // The archive text is always available. Only reach out when something the card
      // needs is still missing, and keep every field optional so an upstream outage
      // degrades to the old text-and-link card instead of losing the embed.
      if (block.videoUrl && block.handle && block.avatarUrl) continue;

      const response = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(block.postId)}&lang=en&token=1`,
        { signal: AbortSignal.timeout(10000) },
      );
      let payload: unknown = response.ok ? await response.json() : null;
      if (payload) applyEmbeddedPayload(block, payload);

      if (!block.videoUrl) {
        const fallback = await fetch(`https://api.fxtwitter.com/status/${encodeURIComponent(block.postId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (fallback.ok) {
          const data = (await fallback.json()) as { tweet?: { media?: { videos?: Array<{ url: string; thumbnail_url: string }> } } };
          applyEmbeddedPayload(block, data);
          const video = data.tweet?.media?.videos?.[0];
          if (video) {
            applyEmbeddedPayload(block, { video: { poster: video.thumbnail_url, variants: [{ type: 'video/mp4', src: video.url }] } });
          }
        }
      }

      if (bucket) {
        await bucket.put(key, JSON.stringify({
          video: block.videoUrl ? { poster: block.poster, variants: [{ type: 'video/mp4', src: block.videoUrl }] } : undefined,
          user: {
            name: block.author,
            screen_name: block.handle,
            profile_image_url_https: block.avatarUrl,
            verified: block.verified,
          },
          created_at: block.postedAt,
          conversation_count: block.replyCount,
          retweet_count: block.repostCount,
          favorite_count: block.likeCount,
          view_count: block.viewCount,
        }), { httpMetadata: { contentType: 'application/json' } });
      }
    } catch {
      // Unavailable posts retain their archived text and original link.
    }
  }
}
