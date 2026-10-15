/** Turn the flattened X post chip into one marker before parsing article prose. */

export interface EmbeddedArticleCard {
  url: string;
  imageUrl: string;
  title: string;
  excerpt?: string;
}

export interface EmbeddedNestedPost {
  url: string;
  author?: string;
  handle?: string;
  avatarUrl?: string;
  verified?: boolean;
  dateLabel?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface PostIdentity {
  avatarUrl?: string;
  verified?: boolean;
  dateLabel?: string;
  truncated?: boolean;
}

export interface RecoveredPost {
  postId: string;
  url: string;
  author: string;
  handle: string;
  text: string;
  avatarUrl?: string;
  verified?: boolean;
  dateLabel?: string;
  truncated?: boolean;
  card?: EmbeddedArticleCard;
  nested?: EmbeddedNestedPost;
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

/** Post text keeps its own line breaks; only runs of spaces and blank lines collapse. */
function readText(fragment: string | undefined): string {
  if (!fragment) return '';
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/**
 * A post can quote another post. X draws the quoted one as a bordered card inside
 * the first, and the capture flattens it into a run of Markdown links — avatar,
 * name, handle, date, then the quoted text and its media. Only the quoted post's own
 * container carries `data-timeline-entry`, so that attribute is what separates a
 * nested post from the post being read.
 */
const NESTED_CONTAINER_RE = /<div[^>]*data-href="\/([^"/]+)\/status\/(\d+)"[^>]*data-timeline-entry[^>]*>/g;

export function recoverNestedPosts(html: string): Map<string, EmbeddedNestedPost> {
  const posts = new Map<string, EmbeddedNestedPost>();
  const containers = [...html.matchAll(NESTED_CONTAINER_RE)];
  const identities = recoverPostIdentities(html);

  for (let i = 0; i < containers.length; i++) {
    const container = containers[i];
    const handle = container?.[1];
    const id = container?.[2];
    const start = container?.index ?? 0;
    if (!id || posts.has(id)) continue;

    // The container is not self-terminating in the text, so the next quoted post —
    // or the end of the document — bounds it.
    const end = containers[i + 1]?.index ?? Math.min(html.length, start + 24_000);
    const window = html.slice(start, end);

    const author = stripTags(/font-bold text-primary line-clamp-1[^"]*">([^<]+)</.exec(window)?.[1]);
    const handleText = stripTags(/text-secondary line-clamp-1 wrap-break-word[^"]*">([^<]+)</.exec(window)?.[1]);
    const dateLabel = stripTags(
      handle ? new RegExp(`href="/${handle}/status/${id}">([^<]+)<`).exec(window)?.[1] : undefined,
    );
    const textAt = /whitespace-pre-wrap wrap-break-word" dir="auto"><span[^>]*>([\s\S]*?)<\/span>/.exec(window);
    const text = textAt ? readText(textAt[1]) : '';
    const mediaFrom = textAt ? start + textAt.index : start;
    const imageUrl = decodeEntities(
      /src="(https:\/\/pbs\.twimg\.com\/media\/[^"]+)"/.exec(html.slice(mediaFrom, end))?.[1] ?? '',
    );
    const videoUrl = /"(https:\/\/video\.twimg\.com\/[^"]+\.mp4)"/.exec(html.slice(mediaFrom, end))?.[1];

    const identity = identities.get(id);
    posts.set(id, {
      url: `https://x.com/${handle}/status/${id}`,
      ...(author ? { author } : {}),
      ...(handleText ? { handle: handleText.replace(/^@/, '') } : {}),
      ...(identity?.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      ...(identity?.verified ? { verified: true } : {}),
      ...(identity?.dateLabel ?? dateLabel ? { dateLabel: identity?.dateLabel ?? dateLabel } : {}),
      ...(text ? { text } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(videoUrl ? { videoUrl } : {}),
    });
  }
  return posts;
}

/**
 * A post's container, in either of the two shapes X writes it: the reader's own URL
 * (`/handle/status/<id>`) and the timeline's (`/i/web/status/<id>`, which names the
 * post rather than its author). Keying on the id alone lets a post be identified from
 * whichever shape the capture happened to carry.
 */
const POST_CONTAINER_RE = /<(?:div|article)[^>]*data-href="\/(?:i\/web\/|[^"/]+\/)status\/(\d+)"[^>]*>/g;

/**
 * Who a post is, read from its own container: the avatar X drew beside the name, the
 * verified seal, the date, and whether X truncated the text behind a "Show more".
 *
 * The syndication endpoint sometimes answers without a profile image, and it never
 * answers with the date X actually displayed — the capture has all four, and the post
 * header is the one place they are read from rather than inferred.
 */
export function recoverPostIdentities(html: string): Map<string, PostIdentity> {
  const identities = new Map<string, PostIdentity>();
  const containers = [...html.matchAll(POST_CONTAINER_RE)];

  for (let i = 0; i < containers.length; i++) {
    const container = containers[i];
    const id = container?.[1];
    const start = container?.index ?? 0;
    if (!id || identities.has(id)) continue;

    const end = containers[i + 1]?.index ?? Math.min(html.length, start + 24_000);
    const window = html.slice(start, end);
    const avatarUrl = avatar(window);
    // The date links to the post itself; matching the id rather than the handle keeps
    // it working for the timeline's `/i/web/` shape, which carries no handle at all.
    const dateLabel = stripTags(
      new RegExp(`href="[^"]*status/${id}">([^<]+)<`).exec(window)?.[1],
    );
    const text = /whitespace-pre-wrap wrap-break-word" dir="auto"><span[^>]*>([\s\S]*?)<\/span>([\s\S]{0,240})/.exec(window);

    identities.set(id, {
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(window.includes('aria-label="Verified account"') ? { verified: true } : {}),
      ...(dateLabel ? { dateLabel } : {}),
      ...(text?.[2]?.includes('Show more') ? { truncated: true } : {}),
    });
  }
  return identities;
}

const avatar = (window: string): string | undefined =>
  decodeEntities(/src="(https:\/\/pbs\.twimg\.com\/profile_images\/[^"]+_normal\.jpg)"/.exec(window)?.[1] ?? '') ||
  undefined;

/**
 * The flattened form of a quoted post, used when the capture had no structured
 * container: four links (avatar, name, handle, date), then the post's own text and
 * media. Everything readable is kept; nothing is printed as Markdown.
 */
const NESTED_MARKDOWN_RE =
  /\[!\[@[^\]]+\]\(https:\/\/pbs\.twimg\.com\/profile_images\/[^)]+\)\]\(https:\/\/x\.com\/[^/)]+\)[\s\S]*?\[([^\]]*)\]\(https:\/\/x\.com\/[^/]+\/status\/(\d+)\)/;

/**
 * X's "Show more" is a button, not part of what anybody wrote. The capture keeps
 * the label, so it is removed — otherwise a quoted post ends with a phrase the
 * author never typed.
 */
function cleanPostText(text: string): string {
  return text.replace(/(?:\s*Show more)+\s*$/i, '').replace(/[ \t]{2,}/g, ' ').trim();
}

export function splitNestedPost(
  text: string,
  posts: Map<string, EmbeddedNestedPost> = new Map(),
): { text: string; nested?: EmbeddedNestedPost } {
  const match = NESTED_MARKDOWN_RE.exec(text);
  if (!match) return { text };

  const id = match[2] ?? '';
  const start = match.index;
  const body = text.slice(start + match[0].length);
  const structured = id ? posts.get(id) : undefined;
  const nested = structured ?? readNestedFromMarkdown(match[0], body, match[1] ?? '', id);

  return {
    text: cleanPostText(text.slice(0, start)),
    nested: { ...nested, ...(id ? { url: `https://x.com/${nested.handle ?? 'i'}/status/${id}` } : {}) },
  };
}

function readNestedFromMarkdown(head: string, body: string, dateLabel: string, id: string): EmbeddedNestedPost {
  const links = [...head.matchAll(/\[(?:!\[)?([^\]]*)\]\((https:\/\/x\.com\/[^)]+)\)/g)].map((m) => ({
    label: m[1] ?? '',
    href: m[2] ?? '',
  }));
  const avatarUrl = decodeEntities(/!\[@[^\]]*\]\((https:\/\/pbs\.twimg\.com\/profile_images\/[^)]+)\)/.exec(head)?.[1] ?? '');
  const handle = links.find((l) => l.label.startsWith('@'))?.label.replace(/^@/, '');
  const author = links.find((l) => !l.label.startsWith('@') && l.label !== '' && !/^\w{3} \d{1,2}$/.test(l.label))?.label;
  const imageUrl = decodeEntities(/!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/media\/[^)]+)\)/.exec(body)?.[1] ?? '');

  const plain = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bShow more\b/g, '')
    .replace(/\bView media\b/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return {
    url: `https://x.com/${handle ?? 'i'}/status/${id}`,
    ...(author ? { author } : {}),
    ...(handle ? { handle } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(dateLabel ? { dateLabel } : {}),
    ...(plain ? { text: plain } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

export function recoverEmbeddedPosts(markdown: string, html: string): {
  markdown: string;
  posts: RecoveredPost[];
} {
  const posts: RecoveredPost[] = [];
  const ids = new Set([...html.matchAll(/data-href=["']\/i\/web\/status\/(\d+)["']/g)].map((m) => m[1]));
  const cards = recoverArticleCards(html);
  const nestedPosts = recoverNestedPosts(html);
  const identities = recoverPostIdentities(html);
  const recovered = markdown.replace(
    /\[!\[[^\]]*\]\([^\n]+\)\]\(https:\/\/x\.com\/[^\n]+\)\n\n\[([^\]]+)\]\(https:\/\/x\.com\/([^\s)]+)\)\n\n\[@[^\]]+\]\([^\n]+\)\n\n\[[^\]]+\]\(https:\/\/x\.com\/[^/]+\/status\/(\d+)\)\n\n([\s\S]*?)\n\n\[[^\]]+\]\(https:\/\/x\.com\/compose\/post\?in_reply_to=\3\)(?:\n\n[\d.,KM]+){0,4}/g,
    (whole, author: string, handle: string, postId: string, body: string) => {
      if (!ids.has(postId)) return whole;
      const text = cleanPostText(body.replace(/\n\n\d{1,2}:\d{2}\s*$/, '').trim());
      const split = splitEmbeddedArticleCard(text, cards);
      const nested = splitNestedPost(split.text, nestedPosts);
      const identity = identities.get(postId);
      posts.push({
        postId,
        url: `https://x.com/${handle}/status/${postId}`,
        author,
        handle,
        text: nested.text,
        ...(identity?.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
        ...(identity?.verified ? { verified: true } : {}),
        ...(identity?.dateLabel ? { dateLabel: identity.dateLabel } : {}),
        ...(identity?.truncated ? { truncated: true } : {}),
        ...(split.card ? { card: split.card } : {}),
        ...(nested.nested ? { nested: nested.nested } : {}),
      });
      return `\n\nXEMBEDPOST${postId}\n\n`;
    },
  );
  return { markdown: recovered, posts };
}