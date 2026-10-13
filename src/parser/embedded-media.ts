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

export async function enrichEmbeddedMedia(document: ArticleDocument, bucket?: R2Bucket): Promise<void> {
  for (const block of document.blocks) {
    if (block.type !== 'embed' || block.videoUrl) continue;
    try {
      const cached = await bucket?.get(`embedded-posts/${block.postId}/media.json`);
      if (cached) {
        const media = extractEmbeddedVideo(await cached.json());
        if (media) { Object.assign(block, media); continue; }
      }
      const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(block.postId)}&lang=en&token=1`,
        { signal: AbortSignal.timeout(10000) });
      let media = response.ok ? extractEmbeddedVideo(await response.json()) : null;
      if (!media) {
        const fallback = await fetch(`https://api.fxtwitter.com/status/${encodeURIComponent(block.postId)}`,
          { signal: AbortSignal.timeout(10000) });
        if (fallback.ok) {
          const data = await fallback.json() as { tweet?: { media?: { videos?: Array<{ url: string; thumbnail_url: string }> } } };
          const video = data.tweet?.media?.videos?.[0];
          if (video) media = extractEmbeddedVideo({ video: { poster: video.thumbnail_url,
            variants: [{ type: 'video/mp4', src: video.url }] } });
        }
      }
      if (media) {
        Object.assign(block, media);
        await bucket?.put(`embedded-posts/${block.postId}/media.json`, JSON.stringify({ video: {
          poster: media.poster, variants: [{ type: 'video/mp4', src: media.videoUrl }],
        } }), { httpMetadata: { contentType: 'application/json' } });
      }
    } catch {
      // Unavailable posts retain their archived text and original link.
    }
  }
}
