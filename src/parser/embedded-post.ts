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
  images?: string[];
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

/**
 * A post's own pictures, lifted out of the flattened text, and everything else the
 * capture left as Markdown put back into words.
 *
 * X flattens a post into image links, "View media" links, a bare "02:53" for a video
 * it could not give us, and a whole link card written as `[![cover](img) title](url)`.
 * A flattened quoted post that the structured passes missed arrives the same way. Left
 * alone that is Markdown printed at the reader — so the pictures are lifted out, the
 * links keep their words, and the labels nobody typed are dropped.
 */
export function extractPostMedia(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const rest = text
    // A video X would not hand over arrives as its poster frame; showing the frame is
    // still more than showing the Markdown that describes it.
    .replace(
      /!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/(?:media|amplify_video_thumb)\/[^)]+)\)/g,
      (_whole, url: string) => {
        images.push(decodeEntities(url));
        return '';
      },
    )
    // A card written as `[![cover](img) title](url)`: the title is the only part that
    // says anything.
    .replace(/\[!\[[^\]]*\]\([^)]*\)([^\]]*)\]\([^)]*\)/g, '$1')
    // Whatever image syntax is left claims nothing worth printing. This runs before the
    // link rule below, or that rule would eat the brackets and leave a bare "!@name".
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Any other link keeps its words, which is at worst a plain sentence.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:Show more|View media|Paid partnership)\b/g, '')
    // A video's running time, standing alone on its own line. The whitespace on either
    // side is horizontal on purpose: a `\s*` here would eat the paragraph break with it.
    .replace(/(?:^|\n)[ \t]*\d{1,2}:\d{2}[ \t]*(?=\n|$)/g, '');

  return {
    text: rest
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .replace(/\n{2,}/g, '\n\n')
      .trim(),
    images,
  };
}

/** Paragraph offsets let us replace a whole post without rewriting surrounding prose. */
function paragraphs(markdown: string): Array<{ text: string; start: number; end: number }> {
  return [...markdown.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)].map((match) => ({
    text: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

const POST_AVATAR_RE = /^\[!\[@[^\]]*\]\(https:\/\/pbs\.twimg\.com\/[^)\n]+\)\]\(https:\/\/x\.com\/([^/)\n]+)\)$/;
const HEADER_IMAGE_RE = /^\[!\[[^\]]*\]\(https:\/\/pbs\.twimg\.com\/profile_images\/[^)\n]+\)\]\(https:\/\/x\.com\/[^/)\n]+\)$/;
const POST_NAME_RE = /^\[([^\]\n]+)\]\(https:\/\/x\.com\/([^/)\n]+)\)$/;
const POST_HANDLE_RE = /^\[@([^\]\n]+)\]\(https:\/\/x\.com\/([^/)\n]+)\)$/;
const POST_DATE_RE = /^\[[^\]\n]+\]\(https:\/\/x\.com\/([^/)\n]+)\/status\/(\d+)\)$/;
const POST_REPLY_RE = /^\[[^\]\n]+\]\(https:\/\/x\.com\/compose\/post\?in_reply_to=(\d+)\)$/;
const POST_COUNT_RE = /^[\d.,]+[KMB]?$/i;
const POST_VIDEO_DURATION_RE = /^\d{1,2}:\d{2}$/;

function sameHandle(a: string, b: string): boolean {
  return a.toLowerCase() === b.replace(/\\([_])/g, '$1').toLowerCase();
}

/** X sometimes inserts a badge or a second account avatar inside a post header. */
function skipHeaderAvatars(parts: ReturnType<typeof paragraphs>, index: number): number {
  let skipped = 0;
  while (skipped < 4 && HEADER_IMAGE_RE.test(parts[index]?.text ?? '')) {
    index++;
    skipped++;
  }
  return index;
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
  const parts = paragraphs(markdown);
  let recovered = '';
  let cursor = 0;

  for (let i = 0; i < parts.length; i++) {
    const avatarHandle = POST_AVATAR_RE.exec(parts[i]?.text ?? '')?.[1];
    if (!avatarHandle) continue;

    const nameIndex = skipHeaderAvatars(parts, i + 1);
    const author = POST_NAME_RE.exec(parts[nameIndex]?.text ?? '');
    if (!author || !sameHandle(avatarHandle, author[2] ?? '')) continue;
    let next = skipHeaderAvatars(parts, nameIndex + 1);
    const handle = POST_HANDLE_RE.exec(parts[next]?.text ?? '');
    if (!handle || !sameHandle(avatarHandle, handle[2] ?? '') || !sameHandle(avatarHandle, handle[1] ?? '')) continue;
    next = skipHeaderAvatars(parts, next + 1);
    const date = POST_DATE_RE.exec(parts[next]?.text ?? '');
    const postId = date?.[2];
    if (!postId || !ids.has(postId) || !sameHandle(avatarHandle, date[1] ?? '')) continue;

    const bodyStart = next + 1;
    let reply = bodyStart;
    // The reply link is the end of this post's content. A bounded search means a
    // malformed capture cannot consume the rest of a long article or a later post.
    while (reply < parts.length && reply - bodyStart < 60 && parts[reply]!.end - parts[bodyStart]!.start < 24_000) {
      if (POST_REPLY_RE.exec(parts[reply]!.text)?.[1] === postId) break;
      if (POST_AVATAR_RE.test(parts[reply]!.text)) break;
      reply++;
    }
    if (reply === bodyStart || reply >= parts.length || POST_REPLY_RE.exec(parts[reply]!.text)?.[1] !== postId) continue;

    let end = reply;
    for (let count = 0; count < 4 && POST_COUNT_RE.test(parts[end + 1]?.text ?? ''); count++) end++;
    // A duration next to engagement controls is video UI, not the author's prose.
    let contentEnd = reply - 1;
    if (POST_VIDEO_DURATION_RE.test(parts[contentEnd]?.text ?? '')) contentEnd--;
    const postBody = contentEnd >= bodyStart
      ? markdown.slice(parts[bodyStart]!.start, parts[contentEnd]!.end)
      : '';
    const split = splitEmbeddedArticleCard(cleanPostText(postBody), cards);
    const nested = splitNestedPost(split.text, nestedPosts);
    const media = extractPostMedia(nested.text);
    const identity = identities.get(postId);
    posts.push({
      postId,
      url: `https://x.com/${avatarHandle}/status/${postId}`,
      author: author[1] ?? '',
      handle: avatarHandle,
      text: media.text,
      ...(identity?.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      ...(identity?.verified ? { verified: true } : {}),
      ...(identity?.dateLabel ? { dateLabel: identity.dateLabel } : {}),
      ...(identity?.truncated ? { truncated: true } : {}),
      ...(media.images.length > 0 ? { images: media.images } : {}),
      ...(split.card ? { card: split.card } : {}),
      ...(nested.nested ? { nested: nested.nested } : {}),
    });
    recovered += markdown.slice(cursor, parts[i]!.start) + `\n\nXEMBEDPOST${postId}\n\n`;
    cursor = parts[end]!.end;
    i = end;
  }
  return { markdown: recovered + markdown.slice(cursor), posts };
}
