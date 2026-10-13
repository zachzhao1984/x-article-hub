/**
 * SPEC §9 — the internal ArticleDocument.
 *
 * This is the contract between the Parser (Phase 3) and everything downstream:
 * the reading page renders blocks from it, the AI step summarises plain text
 * derived from it, and FTS indexes plain text derived from it (SPEC §13.4, §12).
 *
 * SPEC §9.3: the Parser must not rewrite the author's words. Nothing in this file
 * is a place to "improve" prose.
 */

export interface ArticleDocument {
  title: string;

  author: {
    name: string;
    username: string;
    avatar?: string;
  };

  publishedAt?: string;

  blocks: ArticleBlock[];

  links: ArticleLink[];
  images: ArticleImage[];

  source: {
    url: string;
    parserVersion: number;
    capturedAt: string;
  };
}

export type ArticleBlock =
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'heading'; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { type: 'quote'; spans: InlineSpan[] }
  | { type: 'list'; ordered: boolean; items: InlineSpan[][] }
  | { type: 'image'; imageId: string }
  | { type: 'code'; language?: string; code: string }
  | { type: 'embed'; postId: string; url?: string; author?: string; text?: string };

/**
 * A run of inline content within a block.
 *
 * ## Why spans and not a Markdown string
 *
 * The capture is Markdown, and the reading page renders the document — not the Markdown. So a
 * block's text has to be *interpreted*, not passed through, or the reader sees the author's
 * `**bold**` markers as literal asterisks. That was a real bug: every sampled article carried
 * between 11 and 45 literal `**` pairs on the page.
 *
 * The alternative — stripping the markers — loses the emphasis the author chose. Keeping the
 * emphasis means the block text has to be a sequence of runs rather than one string, which is
 * what this is: `strong` and `em` carry the emphasis, `link` carries the target so the phrase
 * stays clickable (the old `inline()` dropped the href entirely, leaving linked text that
 * looked like ordinary words), and `code` keeps an inline code span visually distinct.
 *
 * `text` is the run's words and is never empty; adjacent plain runs are merged by the parser so
 * a paragraph does not arrive as dozens of one-word spans.
 */
export type InlineSpan =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export interface ArticleLink {
  href: string;
  text: string;
}

export interface ArticleImage {
  imageId: string;
  /** SPEC §10 — /media/NNN.webp in R2; null when the download failed. */
  r2Key: string | null;
  sourceUrl: string;
  altText?: string;
  width?: number;
  height?: number;
  /**
   * SPEC §10 — a failed image must not fail the article.
   *
   * `video` is not a failure and not a downgrade: it is a block the pipeline was never
   * going to archive, recorded so the reader gets the original recording instead of an
   * "Image not archived" figure claiming to still load from x.com. See the note on
   * `VIDEO_HOST_RE` in src/parser/markdown.ts.
   */
  status: 'ready' | 'failed' | 'external_fallback' | 'video';
}

/** SPEC §8 — R2 layout. Raw is append-only; normalized can be rebuilt by the Parser. */
export const R2_PATHS = {
  rawHtml: (articleId: string) => `articles/${articleId}/raw/page.html`,
  rawMarkdown: (articleId: string) => `articles/${articleId}/raw/page.md`,
  rawMetadata: (articleId: string) => `articles/${articleId}/raw/metadata.json`,
  screenshot: (articleId: string) => `articles/${articleId}/raw/screenshot.webp`,
  versionJson: (articleId: string, version: number) => `articles/${articleId}/versions/v${version}/article.json`,
  versionMarkdown: (articleId: string, version: number) => `articles/${articleId}/versions/v${version}/article.md`,
  versionHtml: (articleId: string, version: number) => `articles/${articleId}/versions/v${version}/article.html`,
  /**
   * SPEC §8 / §10 — `articles/{id}/media/001.webp`.
   *
   * The extension is a parameter rather than a constant. SPEC §10 writes `.webp`
   * because X serves WebP when asked, but a response that ignored the Accept
   * header would land PNG or JPEG bytes under a `.webp` name, and the reading
   * page would then serve the wrong content type. The extension follows the
   * sniffed format instead, so a `.webp` key always holds WebP.
   */
  media: (articleId: string, index: number, extension: string) =>
    `articles/${articleId}/media/${String(index).padStart(3, '0')}.${extension}`,
  /**
   * The author portrait: the other X CDN hotlink on the reading page, stored under
   * its own name rather than competing for a body ordinal.
   *
   * The extension follows the sniffed format for the same reason `media` does, and
   * this was the one place that still hardcoded `.webp`. X serves a JPEG for the
   * `profile_images/..._normal.jpg` avatar, so every stored avatar was JPEG bytes
   * under a `.webp` name. The page still rendered, because /media serves the
   * content type from D1 rather than from the key — but a key that misdescribes
   * its own contents is exactly the failure this parameter exists to prevent.
   */
  avatar: (articleId: string, extension: string) => `articles/${articleId}/media/avatar.${extension}`,
  /**
   * A generated cover for an article whose document has no body image to use.
   *
   * Its own name rather than a body ordinal, for the same reason `avatar` has one: it is
   * not part of the article, so giving it a position would put it in competition with the
   * figures the author actually inserted, and `downloadArticleMedia`'s sweep would delete
   * it as an unclaimed object. Under `media/` it still lives inside the prefix the article
   * owns, so SPEC §16's hard delete sweeps it with everything else.
   */
  cover: (articleId: string, extension: string) => `articles/${articleId}/media/cover.${extension}`,
} as const;

/**
 * The words of a span run, with no markup.
 *
 * The inverse of `parseInline`, and the only thing that should ever read a span's text: FTS
 * indexes it, the word count counts it, and the reading page renders the spans themselves. A
 * caller that wants the plain string of a block goes through here rather than reaching into
 * each span, so the `type` discriminator is handled in one place — which is what broke when the
 * document moved from `text: string` to spans.
 */
export function inlineToText(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/** SPEC §13.4 / §12 — derive indexable plain text. Never hand raw HTML to a model or FTS. */
export function documentToPlainText(doc: ArticleDocument): string {
  const parts: string[] = [doc.title];

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        parts.push(inlineToText(block.spans));
        break;
      case 'list':
        parts.push(block.items.map(inlineToText).join('\n'));
        break;
      case 'code':
        parts.push(block.code);
        break;
      case 'image':
        break;
      case 'embed':
        if (block.text) parts.push(block.text);
        break;
    }
  }

  return parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * SPEC §11.4 — `word_count` feeds the AI input cap and the reading-time estimate.
 *
 * Whitespace tokenisation is wrong for CJK, which is the common case here: a
 * 10,000-character Chinese article has almost no spaces and would count as a few
 * hundred "words", understating both the AI budget and the reading time by ~5x.
 * Each CJK ideograph is counted as one word, and Latin runs are counted normally.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // CJK Unified Ideographs and the Japanese kana block, plus CJK punctuation that
  // is not whitespace-separated in practice.
  const cjk = trimmed.match(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]/g)?.length ?? 0;

  // Remove CJK, then count what remains as whitespace-delimited Latin words.
  const latin = trimmed.replace(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]/g, ' ');
  const latinWords = latin.trim() ? latin.trim().split(/\s+/).length : 0;

  return cjk + latinWords;
}
