import type { ArticleDocument } from '../types/article-document';

export interface AppCardMeta {
  title?: string;
  imageUrl?: string;
  description?: string;
}

/** x.ai serves the plugin banner itself; a card that pulls its art from anywhere else is not this plugin. */
const isXAiImage = (url: string | undefined): url is string => Boolean(url && /^https:\/\/x\.ai\//.test(url));

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** Open Graph tags, read without a DOM: the Worker has none and the order of attributes is not guaranteed. */
function metaContent(html: string, property: string): string | undefined {
  const wanted = new RegExp(`property=["']${property}["']`, 'i');
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!wanted.test(tag)) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decodeEntities(content);
  }
  return undefined;
}

export function extractAppCardMeta(html: string): AppCardMeta {
  const title = metaContent(html, 'og:title');
  const image = metaContent(html, 'og:image');
  const description = metaContent(html, 'og:description');
  return {
    ...(title ? { title } : {}),
    ...(isXAiImage(image) ? { imageUrl: image } : {}),
    ...(description ? { description } : {}),
  };
}

const cacheKey = (url: string): string =>
  `app-cards/${url.replace(/^https:\/\//, '').replace(/[^a-z0-9]+/gi, '-')}.json`;

/**
 * A bare x.ai plugin link in an article is a link to an app, and X renders it as a
 * banner card rather than a line of text. The banner is the page's own og:image —
 * same art the reader would see on X — cached in R2 so the reading page never
 * fetches x.ai at request time.
 */
export async function enrichAppCards(document: ArticleDocument, bucket?: R2Bucket): Promise<void> {
  for (const block of document.blocks) {
    if (block.type !== 'app') continue;
    const key = cacheKey(block.url);
    try {
      const cached = await bucket?.get(key);
      if (cached) Object.assign(block, (await cached.json()) as AppCardMeta);

      if (block.title && block.imageUrl) continue;

      const response = await fetch(block.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XArticleHub/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;

      const meta = extractAppCardMeta(await response.text());
      Object.assign(block, meta);

      if (bucket && Object.keys(meta).length > 0) {
        await bucket.put(key, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      }
    } catch {
      // The link still renders as a labelled card without a banner.
    }
  }
}
