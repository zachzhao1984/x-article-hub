import { inlineToText, type ArticleDocument } from '../types/article-document';

const decode = (text: string): string => text
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const words = (text: string): string => decode(text).replace(/<[^>]*>/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Markdown conversion omits HTML videos. Recover links without fetching their bytes. */
export function recoverVideoLinks(document: ArticleDocument, html: string): number {
  let recovered = 0;
  for (const match of html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
    const tag = match[0];
    const rawUrl = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!rawUrl) continue;
    const url = decode(rawUrl);
    // Accept actual X media only; never turn a script URL into a rendered anchor.
    if (!/^https:\/\/(?:video\.twimg\.com|video\.twitter\.com)\//i.test(url)) continue;
    if (document.images.some((image) => image.sourceUrl === url)) continue;

    const before = html.slice(0, match.index);
    const preceding = [...before.matchAll(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)].at(-1);
    const anchor = preceding ? words(preceding[2] ?? '') : '';
    let position = document.blocks.length;
    if (anchor) {
      const index = document.blocks.findIndex((block) =>
        (block.type === 'paragraph' || block.type === 'heading' || block.type === 'quote') &&
        words(inlineToText(block.spans)) === anchor);
      if (index >= 0) {
        position = index + 1;
        while (document.blocks[position]?.type === 'image' &&
          document.images.some((image) => image.status === 'video' &&
            image.imageId === (document.blocks[position] as { imageId: string }).imageId)) position++;
      }
    }
    const after = html.slice(match.index! + tag.length);
    const figureEnd = after.indexOf('</figure>');
    const caption = figureEnd >= 0
      ? /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(after.slice(0, figureEnd))?.[1]
      : undefined;
    const imageId = `video_${document.images.length}`;
    document.images.push({ imageId, sourceUrl: url, r2Key: null, status: 'video',
      ...(caption ? { altText: decode(caption.replace(/<[^>]*>/g, '')).trim() } : {}) });
    document.blocks.splice(position, 0, { type: 'image', imageId });
    recovered++;
  }
  return recovered;
}
