/**
 * SPEC §9 — Markdown → ArticleDocument.
 *
 * Why Markdown and not the rendered HTML: SPEC §7.2 notes that `/markdown`'s
 * weakness is metadata and media mapping, not structure. The rendered X DOM is a
 * React tree whose selectors break whenever the site changes (SPEC §26 item 3),
 * whereas the Markdown already encodes the author's own structure — headings,
 * quotes, lists, code fences, links, image order — deterministically. §26's rule
 * is "semantic selector → fallback selector → content extraction heuristic";
 * Markdown is the first of those.
 *
 * SPEC §9.3, and the reason this file exists as a pure function:
 *   - preserve paragraph structure
 *   - preserve heading levels
 *   - preserve links
 *   - preserve image order
 *   - preserve quotes
 *   - preserve code blocks where possible
 *   - strip scripts and irrelevant UI
 *   - DO NOT rewrite the author's words
 *
 * The last point is why there is no normalisation, no de-duplication of prose and
 * no LLM anywhere in this file.
 */

import type { ArticleBlock, ArticleDocument, ArticleImage, ArticleLink, InlineSpan } from '../types/article-document';
import { parseFrontmatter, splitXTitle, stripXTitleSuffix } from '../jobs/x-selectors';

/** SPEC §9.2 only defines heading levels 1–3. Deeper levels clamp rather than drop. */
const MAX_HEADING_LEVEL = 3;

/** `[![](src)](href)` — X renders images wrapped in a link to the media viewer. */
const LINKED_IMAGE_RE = /^\[!\[[^\]]*\]\(([^)\s]+)\)([^\]]*)\]\(([^)\s]+)\)\s*$/;
/** `![alt](src)` */
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
/** Inline `[text](href)`, and reference-free bare autolinks. */
const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BARE_URL_RE = /(?:^|\s)(https?:\/\/[^\s<>()]+)/;
/** A whole paragraph that is nothing but an x.ai plugin link: it renders as an app card, not a URL. */
const APP_LINK_RE = /^https:\/\/x\.ai\/bot\/plugin\/\d+\/?$/;
const ORDERED_ITEM_RE = /^(\d+)[.)]\s+(.*)$/;
const UNORDERED_ITEM_RE = /^[-*+]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(?:```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/;

/**
 * SPEC §9.3 — the inline constructs the author's Markdown can contain.
 *
 * Ordered alternation: `code` first, because a backtick span is literal and must not have its
 * contents interpreted (`` **not bold** `` inside backticks is text). Then links, then
 * emphasis. `**` before `*` so a strong run is not read as two nested emphasis runs.
 *
 * Emphasis requires a non-space character immediately inside the markers, so `2 * 3 * 4` and a
 * stray `*` are left as text rather than swallowing the words between them. X's own prose
 * contains both.
 */
const INLINE_TOKEN_RE =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^\s*][^*]*?\*\*)|(__[^\s_][^_]*?__)|(\*[^\s*][^*\n]*?\*)|(_[^\s_][^_\n]*?_)/;

/**
 * SPEC §9.3 — Markdown inline → spans.
 *
 * ## Why this exists
 *
 * The capture is Markdown and the reading page renders the document, so a block's text has to
 * be interpreted rather than passed through. It was not: only links and bare URLs were handled,
 * so `**bold**` reached the page as literal asterisks — measured on production, every sampled
 * article carried between 11 and 45 literal `**` pairs.
 *
 * The fix is not to strip the markers, because discarding them loses the author's emphasis and
 * SPEC §9.3's rule is to preserve the author's structure. The markers become typed runs, and
 * the reading page renders those.
 *
 * ## What it deliberately does not do
 *
 * No nesting (`**bold with *italic* inside**` keeps the inner markers as text) and no
 * reference-style links. Both are rare in X's Markdown, and a partial implementation that tried
 * would be a second Markdown parser to keep correct — the opposite of why the capture is trusted
 * as the structural source in the first place. Bare URLs are still recorded as links in
 * `document.links` by the caller, but are not turned into anchors here: X's own prose is full of
 * them and the reading page already links the original separately.
 */
/**
 * Emphasis markers removed from a string, for the one place spans cannot nest.
 *
 * A link label is a single string, so `[**Text**](url)` cannot carry a `strong` inside it. The
 * markers are dropped rather than kept: inside a link they are redundant, because the anchor
 * already sets the phrase apart, and keeping them showed the reader literal asterisks.
 */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*|__/g, '').replace(/(^|[^\w])\*([^*]+)\*(?=[^\w]|$)/g, '$1$2');
}

function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // X's capture can duplicate bold delimiters (****label****). Keep code
  // literal, and protect escaped punctuation while matching emphasis.
  const escaped: string[] = [];
  let rest = text.split(/(`[^`\n]+`)/).map((part, index) => index % 2 ? part : part
    .replace(/\\([\\`*_[\]{}()#+.!>~-])/g, (_match, character: string) => {
      escaped.push(character);
      return `\uE000${escaped.length - 1}\uE001`;
    })
    .replace(/\*{4}(?=\S)([\s\S]*?\S)\*{4}/g, '**$1**')
  ).join('');

  const push = (span: InlineSpan): void => {
    const last = spans[spans.length - 1];
    // Merge adjacent plain runs, so a paragraph arrives as a few spans rather than one per
    // word — the page renders one text node per span and a hundred of them is a real cost.
    if (span.type === 'text' && last && last.type === 'text') {
      last.text += span.text;
      return;
    }
    spans.push(span);
  };

  for (;;) {
    const match = INLINE_TOKEN_RE.exec(rest);
    if (!match || match.index === undefined) break;

    if (match.index > 0) push({ type: 'text', text: rest.slice(0, match.index) });
    const token = match[0];
    rest = rest.slice(match.index + token.length);

    if (match[1]) {
      push({ type: 'code', text: token.slice(1, -1) });
    } else if (match[2]) {
      const inner = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (inner) {
        // A link label may itself carry emphasis — `[**Mafia**](url)` — and `link` has no
        // nested spans, so the markers are dropped rather than rendered. They are redundant
        // inside a link anyway: the anchor already distinguishes the phrase from the prose
        // around it, which is what the emphasis was doing. Keeping them was a visible bug —
        // the literal `**` appeared in the link text.
        push({ type: 'link', text: stripEmphasis(inner[1] ?? ''), href: inner[2] ?? '' });
      }
    } else if (match[3]) {
      push({ type: 'strong', text: token.slice(2, -2) });
    } else if (match[4]) {
      push({ type: 'strong', text: token.slice(2, -2) });
    } else if (match[5]) {
      push({ type: 'em', text: token.slice(1, -1) });
    } else if (match[6]) {
      push({ type: 'em', text: token.slice(1, -1) });
    }
  }

  if (rest) push({ type: 'text', text: rest });

  // A run that is only whitespace at either edge is trimmed off, so the block does not render
  // leading or trailing space the author did not put inside the markup.
  const first = spans[0];
  const lastSpan = spans[spans.length - 1];
  if (first && first.type === 'text') first.text = first.text.replace(/^\s+/, '');
  if (lastSpan && lastSpan.type === 'text') lastSpan.text = lastSpan.text.replace(/\s+$/, '');
  return spans.filter((s) => s.text !== '').map((span) => ({
    ...span,
    text: span.text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => escaped[Number(index)] ?? ''),
  }));
}

/**
 * SPEC §7.2 — "/markdown 的元数据和媒体映射需要额外处理".
 *
 * X renders the byline as a linked avatar whose alt text is
 * `Display Name @handle · Mon D`, wrapped in a link to the bare profile URL:
 *
 *   [![灰原学姐](…/profile_images/….jpg)灰原学姐@ HaibaraCrypto·Sep 26](https://x.com/HaibaraCrypto)
 *
 * Parsed naively this becomes a body image of someone's face with a garbled
 * caption, so it is recognised as metadata and lifted out of the content.
 *
 * Two independent signals, either of which is conclusive on its own:
 *   1. the href is a bare profile URL — a body image links to `/media/<id>`
 *   2. the src path is X's avatar CDN path
 */
const PROFILE_LINK_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i;
const AVATAR_CDN_RE = /\/profile_images\//i;

/**
 * Hosts that serve X video, and the container extensions X serves.
 *
 * Recognised so a video is *not* treated as an image. It used to be: `addImage` took any
 * URL, so a `![](…mp4)` became a `media_objects` row, the media pipeline rejected it on
 * the content-type gate, and the reading page then rendered an "Image not archived" figure
 * explaining that the figure "still loads from x.com and may stop working". For a video
 * that is simply false — it was never archived and never rendered as an image, and nothing
 * was going to break. It also occupied a `<figure>` with a reserved box, so the reader saw
 * an image slot claiming to work rather than the recording they came for.
 *
 * `video.twimg.com` is where X serves the actual bytes, but the URL a reader sees in the
 * page markup is usually the status permalink, so both are matched. The extension test is
 * deliberately narrow: it only ever turns an image into a link, and calling a real image a
 * video would lose the image.
 */
const VIDEO_HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:video\.twimg\.com|video\.twitter\.com)\//i;
const VIDEO_EXT_RE = /\.(?:mp4|m4v|mov|webm|m3u8)(?:$|\?)/i;

function isVideoUrl(url: string): boolean {
  return VIDEO_HOST_RE.test(url) || VIDEO_EXT_RE.test(url);
}

export interface ParseOptions {
  url: string;
  /** Author already known from the crawl; the Markdown author chip is a fallback. */
  authorName?: string | null;
  authorUsername?: string | null;
  /** ISO string from the crawl, which can read `<time datetime=...>`. */
  publishedAt?: string | null;
  parserVersion: number;
  capturedAt: string;
}

export interface ParseResult {
  document: ArticleDocument;
  warnings: string[];
  /** Present when the capture carried X's author chip; useful for diagnostics. */
  authorChip?: { avatarUrl: string; name: string | null; dateHint: string | null } | null;
}

export function parseMarkdownToDocument(markdown: string, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];

  const frontmatter = parseFrontmatter(markdown);
  const body = stripFrontmatter(markdown);

  const header = readHeader(frontmatter, opts);

  const { blocks, links, images, authorChip } = parseBlocks(
    body,
    header.title,
    warnings,
    // The canonical URL is the Article's identity here. SPEC §10 keys stored media
    // by article, so an image id has to be unique per article rather than per URL.
    opts.url,
  );

  const document: ArticleDocument = {
    title: header.title,
    author: {
      // SPEC §9.1 types these as required. The URL was normalized from
      // /<username>/article/<id>, so the handle is always available even when the
      // capture carried no author name. The chip's alt text beats the fallback.
      name: header.authorName ?? authorChip?.name ?? header.authorUsername ?? 'Unknown',
      username: header.authorUsername ?? 'unknown',
      // The chip is the only reliable avatar source. `og:image` on an X Article is
      // the cover image, not a face — rendering it as an avatar is its own bug.
      avatar: authorChip?.avatarUrl ?? undefined,
    },
    publishedAt: opts.publishedAt ?? header.publishedAt ?? undefined,
    blocks,
    links,
    images,
    source: {
      url: opts.url,
      parserVersion: opts.parserVersion,
      capturedAt: opts.capturedAt,
    },
  };

  return { document, warnings, authorChip };
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\n+/, '');
}

/**
 * SPEC §9.1 — title and author come from the crawl when it managed to read them,
 * and from the frontmatter otherwise. `og:title` is preferred over the document
 * `<title>`, which X decorates with its own branding.
 */
function readHeader(
  fm: Record<string, string>,
  opts: ParseOptions,
): { title: string; authorName: string | null; authorUsername: string | null; publishedAt: string | null } {
  const title = stripXTitleSuffix(fm['og:title'] ?? fm.title ?? '') || 'Untitled';

  const fromTitle = fm.title ? splitXTitle(fm.title) : { name: null, username: null };
  const fromAuthor = fm.author ? { name: fm.author, username: null } : { name: null, username: null };
  const urlUsername =
    /x\.com\/([A-Za-z0-9_]{1,15})\/(?:article|status)\//.exec(opts.url)?.[1]?.toLowerCase() ?? null;

  return {
    title,
    // The URL is authoritative for the handle: it is the dedup key's own input.
    authorUsername: urlUsername ?? opts.authorUsername ?? fromTitle.username ?? null,
    // SPEC §27 — fresh extraction outranks the stored column. A column written by
    // an older, buggier extractor must not outvote the current one, or a bad
    // value is permanent.
    authorName: fromAuthor.name ?? opts.authorName ?? null,
    publishedAt: null,
  };
}

interface ParsedBlocks {
  blocks: ArticleBlock[];
  links: ArticleLink[];
  images: ArticleImage[];
  authorChip: { avatarUrl: string; name: string | null; dateHint: string | null } | null;
}

function parseBlocks(
  body: string,
  documentTitle: string,
  warnings: string[],
  articleScope: string,
): ParsedBlocks {
  const lines = body.split('\n');
  const blocks: ArticleBlock[] = [];
  const links: ArticleLink[] = [];
  const images: ArticleImage[] = [];

  const seenLinks = new Set<string>();
  const seenImages = new Set<string>();

  /** Lifted out of the content stream when the author chip is met. */
  let authorChip: { avatarUrl: string; name: string | null; dateHint: string | null } | null = null;

  const addLink = (href: string, text: string) => {
    if (!href || seenLinks.has(href)) return;
    seenLinks.add(href);
    links.push({ href, text });
  };

  const addImage = (src: string, altText?: string) => {
    if (!src || seenImages.has(src)) return null;
    seenImages.add(src);

    // SPEC §36 — key media off the source URL so a re-parse or a re-crawl
    // reuses the same download instead of fetching the bytes twice.
    //
    // Scoped to the article, because the same image legitimately appears in more
    // than one Article. Keying on the URL alone made the id collide across
    // articles — a shared avatar, or a syndicated screenshot — and `media_objects`
    // has the image id as its PRIMARY KEY, so the second article's media run died
    // on a UNIQUE violation. The article scope keeps the reuse-within-an-article
    // property that was the point, without claiming global ownership of a URL.
    const imageId = `img_${hash32(`${articleScope} ${src}`)}`;
    const image: ArticleImage = {
      imageId,
      r2Key: null,
      sourceUrl: src,
      altText: altText?.trim() || undefined,
      // SPEC §10 — `external_fallback` is the honest state until the media
      // pipeline downloads and stores the bytes in R2.
      //
      // A video never gets there, and calling one `external_fallback` is what made the
      // reading page lie: that state renders as "Image not archived — this figure still
      // loads from x.com", which is true of an image whose download failed and false of
      // a video the pipeline was never going to archive. `video` keeps it out of the
      // pipeline's work list instead, so it stays a link to the recording.
      status: isVideoUrl(src) ? 'video' : 'external_fallback',
    };
    images.push(image);
    return imageId;
  };

  /**
   * Inline text -> spans, recording the link targets on the way.
   *
   * `addLink` still runs for every Markdown link and every bare URL the author wrote, so
   * `document.links` remains the complete list of where the piece points. What changed is that
   * the *rendered* text keeps its structure: a `**bold**` run reaches the page as a `strong`
   * span instead of literal asterisks, and a `[label](href)` keeps its target as a `link` span
   * rather than being flattened into words that look like ordinary prose.
   */
  const inline = (text: string): InlineSpan[] => {
    const spans = parseInline(text);
    for (const span of spans) {
      if (span.type === 'link') addLink(span.href, span.text);
    }
    // A bare URL stays plain text, but it is still a target the article points at.
    for (const bare of text.matchAll(new RegExp(BARE_URL_RE.source, 'g'))) {
      if (bare[1]) addLink(bare[1], bare[1]);
    }
    return spans;
  };

  let index = 0;
  let sawProse = false;
  /** Consecutive items of the same kind collapse into one list block (SPEC §9.2). */
  let listBuffer: { ordered: boolean; items: InlineSpan[][] } | null = null;

  const flushList = () => {
    if (!listBuffer) return;
    blocks.push({ type: 'list', ordered: listBuffer.ordered, items: listBuffer.items });
    listBuffer = null;
  };

  const pushParagraph = (raw: string) => {
    const trimmed = raw.trim();
    if (APP_LINK_RE.test(trimmed)) {
      sawProse = true;
      blocks.push({ type: 'app', url: trimmed });
      return;
    }
    const spans = inline(raw);
    if (spans.length > 0) {
      sawProse = true;
      blocks.push({ type: 'paragraph', spans });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // --- fenced code (SPEC §9.2 code, §9.3 "尽量保留代码块") ------------------
    const fence = FENCE_RE.exec(line.trim());
    if (fence) {
      flushList();
      let language = fence[1] || undefined;
      // X exports its code-language chip as a paragraph before a bare fence.
      const previous = blocks.at(-1);
      if (!language && previous?.type === 'paragraph' && previous.spans.length === 1 && previous.spans[0]?.type === 'text') {
        const label = previous.spans[0].text.trim().toLowerCase();
        if (/^(text|plaintext|javascript|typescript|js|ts|jsx|tsx|json|html|css|bash|sh|shell|python|py|markdown|md|http|sql|yaml|yml|xml|go|rust|java|c|cpp|ruby|php)$/.test(label)) {
          language = label;
          blocks.pop();
        }
      }
      const body2: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test((lines[index] ?? '').trim())) {
        body2.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ type: 'code', language, code: body2.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushList();
      index += 1;
      continue;
    }

    // --- images (SPEC §9.3 "保留图片顺序") -----------------------------------
    const linked = LINKED_IMAGE_RE.exec(line.trim());
    if (linked) {
      const [, src = '', altText = '', href = ''] = linked;

      if (PROFILE_LINK_RE.test(href) || AVATAR_CDN_RE.test(src)) {
        // Metadata, not content. SPEC §9.3 says preserve the author's structure;
        // it does not say to publish someone's face as a figure mid-article.
        flushList();
        authorChip = {
          avatarUrl: src,
          name: altText.split('@')[0]?.trim() || null,
          dateHint: altText.split('·')[1]?.trim() || null,
        };
        index += 1;
        continue;
      }

      flushList();
      const imageId = addImage(src, altText);
      if (imageId) blocks.push({ type: 'image', imageId });
      if (href) addLink(href, 'media');
      index += 1;
      continue;
    }

    const bare = IMAGE_RE.exec(line.trim());
    if (bare) {
      flushList();
      const [, altText = '', src = ''] = bare;
      const imageId = addImage(src, altText);
      if (imageId) blocks.push({ type: 'image', imageId });
      index += 1;
      continue;
    }

    // --- headings (SPEC §9.3 "保留 Heading 层级") ----------------------------
    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      flushList();
      const rawLevel = (heading[1] ?? '#').length;
      const spans = inline(heading[2] ?? '');
      // The plain form, for the duplicate-title check below: it compares words, and
      // spans have no single string to compare.
      const headingText = spans.map((sp) => sp.text).join('');

      // The capture's own `# Title` duplicates `document.title`. SPEC §9.1 keeps
      // the title in one place, so a leading h1 that repeats it is dropped rather
      // than rendered twice. The test is "no prose yet", not "no blocks yet":
      // X puts a cover image above the title, and that must not defeat the check.
      // NB: advance first. An earlier version `continue`d without moving `index`,
      // which was harmless while the condition never matched and hung the worker
      // the moment it did.
      if (rawLevel === 1 && !sawProse && headingText === documentTitle) {
        index += 1;
        continue;
      }

      if (spans.length > 0) {
        sawProse = true;
        blocks.push({
          type: 'heading',
          level: Math.min(rawLevel, MAX_HEADING_LEVEL) as 1 | 2 | 3,
          spans,
        });
      }
      index += 1;
      continue;
    }

    // --- quotes (SPEC §9.3 "保留 Quote") --------------------------------------
    if (/^>\s?/.test(line)) {
      flushList();
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      const spans = inline(quoted.join(' ').trim());
      if (spans.length > 0) {
        sawProse = true;
        blocks.push({ type: 'quote', spans });
      }
      continue;
    }

    // --- lists ---------------------------------------------------------------
    const ordered = ORDERED_ITEM_RE.exec(line.trim());
    const unordered = UNORDERED_ITEM_RE.exec(line.trim());

    if (ordered || unordered) {
      const isOrdered = Boolean(ordered);

      // Nesting is visible only in the raw line's indentation, so it must be read
      // before trimming — and decided before the marker-kind switch, because a
      // nested `-` under an ordered `1.` would otherwise flush the parent list and
      // become a sibling. ArticleBlock cannot express nesting, so the child is
      // flattened into its parent rather than dropped, and the reshaping is
      // reported rather than done silently.
      const nested = /^\s{2,}(?:[-*+]|\d+[.)])\s+/.test(line);

      if (nested && listBuffer) {
        warnings.push('Nested list items were flattened; ArticleBlock has no nesting.');
        listBuffer.items.push(inline((ordered?.[2] ?? unordered?.[1] ?? '').trim()));
        index += 1;
        continue;
      }

      if (!listBuffer || listBuffer.ordered !== isOrdered) {
        flushList();
        sawProse = true;
        listBuffer = { ordered: isOrdered, items: [] };
      }
      listBuffer.items.push(inline((ordered?.[2] ?? unordered?.[1] ?? '').trim()));
      index += 1;
      continue;
    }

    // --- paragraph: consecutive non-blank lines join (Markdown soft wrap) ------
    flushList();
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '') break;
      if (HEADING_RE.test(current.trim()) || FENCE_RE.test(current.trim())) break;
      if (/^>\s?/.test(current)) break;
      if (ORDERED_ITEM_RE.test(current.trim()) || UNORDERED_ITEM_RE.test(current.trim())) break;
      if (LINKED_IMAGE_RE.test(current.trim()) || IMAGE_RE.test(current.trim())) break;
      paragraph.push(current.trim());
      index += 1;
    }
    pushParagraph(paragraph.join(' '));
  }

  flushList();

  if (blocks.length === 0) {
    warnings.push('No blocks were extracted from the capture.');
  }

  return { blocks, links, images, authorChip };
}

/**
 * FNV-1a, hex-truncated. Not cryptographic — this only needs to be a stable
 * identifier for "the same image URL", which §36 requires for media dedup.
 */
function hash32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
