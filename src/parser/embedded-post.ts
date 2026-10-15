/** Turn the flattened X post chip into one marker before parsing article prose. */

export interface EmbeddedArticleCard {
  url: string;
  imageUrl: string;
  title: string;
  excerpt?: string;
}

export interface RecoveredPost {
  postId: string;
  url: string;
  author: string;
  handle: string;
  text: string;
  card?: EmbeddedArticleCard;
}

/**
 * X renders a quoted X Article as a cover image plus a title and an excerpt. The
 * capture flattens all three into one Markdown link, so without this the reading
 * page prints literal `![Article cover image](…)` text inside the quoted post.
 *
 * The archived HTML still has the three parts in their own elements, so the title
 * and excerpt are read from there rather than guessed back out of the flattened
 * string: the seam between them is not recoverable from the text alone.
 */
export function recoverArticleCards(html: string): Map<string, EmbeddedArticleCard> {
  const cards = new Map<string, EmbeddedArticleCard>();
  for (const match of html.matchAll(/<a[^>]+href=["']\/i\/article\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/g)) {
    const id = match[1];
    const inner = match[2] ?? '';
    if (!id || cards.has(id)) continue;

    const rawImage = /<img[^>]+src="([^"]+)"/.exec(inner)?.[1];
    const imageUrl = rawImage ? decodeEntities(rawImage) : undefined;
    const title = stripTags(/<div[^>]*class="[^"]*font-extrabold[^"]*mb-2[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(inner)?.[1]);
    const excerpt = stripTags(/<div[^>]*class="[^"]*line-clamp-4[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(inner)?.[1]);
    if (!title || !imageUrl || !/^https:\/\/pbs\.twimg\.com\/media\//.test(imageUrl)) continue;

    cards.set(id, {
      url: `https://x.com/i/article/${id}`,
      imageUrl,
      title,
      ...(excerpt ? { excerpt } : {}),
    });
  }
  return cards;
}

/**
 * The flattened form, used when the HTML did not carry the card. The Markdown is
 * removed rather than printed, and what is left is a title — long, but readable,
 * instead of a broken image link.
 */
const ARTICLE_CARD_MARKDOWN_RE =
  /\[!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/media\/[^)]+)\)\s*([\s\S]*?)\]\((https:\/\/x\.com\/i\/article\/\d+)\)/;

/**
 * X's card text puts a space between every CJK glyph when it flattens to plain
 * text ("如 何 用 VPS"). Read on its own that is a typesetting artefact of the
 * capture, not something the author wrote, so the spaces go back out.
 */
const CJK = '\\u3000-\\u9fff\\uff00-\\uffef';

function stripTags(fragment: string | undefined): string {
  if (!fragment) return '';
  return decodeEntities(fragment.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tidyCjkSpacing(value: string): string {
  return value.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1');
}

export function splitEmbeddedArticleCard(
  text: string,
  cards: Map<string, EmbeddedArticleCard> = new Map(),
): { text: string; card?: EmbeddedArticleCard } {
  const match = ARTICLE_CARD_MARKDOWN_RE.exec(text);
  if (!match) return { text };

  const markdownImage = match[1] ?? '';
  const label = (match[2] ?? '').replace(/^\s*Article\s+/i, '').trim();
  const articleUrl = match[3] ?? '';
  const id = /\/i\/article\/(\d+)/.exec(articleUrl)?.[1];

  const structured = id ? cards.get(id) : undefined;
  const fallbackTitle = tidyCjkSpacing(label).slice(0, 120).replace(/\s+\S*$/, '');
  const card: EmbeddedArticleCard = {
    url: articleUrl,
    imageUrl: structured?.imageUrl ?? markdownImage,
    title: structured?.title ?? (fallbackTitle || label),
    ...(structured?.excerpt ? { excerpt: structured.excerpt } : {}),
  };

  const remainder = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: remainder, card };
}

export function recoverEmbeddedPosts(markdown: string, html: string): {
  markdown: string;
  posts: RecoveredPost[];
} {
  const posts: RecoveredPost[] = [];
  const ids = new Set([...html.matchAll(/data-href=["']\/i\/web\/status\/(\d+)["']/g)].map((m) => m[1]));
  const cards = recoverArticleCards(html);
  const recovered = markdown.replace(
    /\[!\[[^\]]*\]\([^\n]+\)\]\(https:\/\/x\.com\/[^\n]+\)\n\n\[([^\]]+)\]\(https:\/\/x\.com\/([^\s)]+)\)\n\n\[@[^\]]+\]\([^\n]+\)\n\n\[[^\]]+\]\(https:\/\/x\.com\/[^/]+\/status\/(\d+)\)\n\n([\s\S]*?)\n\n\[[^\]]+\]\(https:\/\/x\.com\/compose\/post\?in_reply_to=\3\)(?:\n\n[\d.,KM]+){0,4}/g,
    (whole, author: string, handle: string, postId: string, body: string) => {
      if (!ids.has(postId)) return whole;
      const text = body.replace(/\n\n\d{1,2}:\d{2}\s*$/, '').trim();
      const split = splitEmbeddedArticleCard(text, cards);
      posts.push({
        postId,
        url: `https://x.com/${handle}/status/${postId}`,
        author,
        handle,
        text: split.text,
        ...(split.card ? { card: split.card } : {}),
      });
      return `\n\nXEMBEDPOST${postId}\n\n`;
    },
  );
  return { markdown: recovered, posts };
}