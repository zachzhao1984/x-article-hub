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

import type { ArticleBlock, ArticleDocument, ArticleImage, ArticleLink } from '../types/article-document';
import { parseFrontmatter, splitXTitle, stripXTitleSuffix } from '../jobs/x-selectors';

/** SPEC §9.2 only defines heading levels 1–3. Deeper levels clamp rather than drop. */
const MAX_HEADING_LEVEL = 3;

/** `[![](src)](href)` — X renders images wrapped in a link to the media viewer. */
const LINKED_IMAGE_RE = /^\[!\[[^\]]*\]\(([^)\s]+)\)([^\]]*)\]\(([^)\s]+)\)\s*$/;
/** `![alt](src)` */
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
/** Inline `[text](href)`, and reference-free bare autolinks. */
const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL_RE = /(?:^|\s)(https?:\/\/[^\s<>()]+)/g;
const ORDERED_ITEM_RE = /^(\d+)[.)]\s+(.*)$/;
const UNORDERED_ITEM_RE = /^[-*+]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(?:```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/;

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
}

export function parseMarkdownToDocument(markdown: string, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];

  const frontmatter = parseFrontmatter(markdown);
  const body = stripFrontmatter(markdown);

  const header = readHeader(frontmatter, opts);

  const { blocks, links, images } = parseBlocks(body, header.title, warnings);

  const document: ArticleDocument = {
    title: header.title,
    author: {
      // SPEC §9.1 types these as required. The URL was normalized from
      // /<username>/article/<id>, so the handle is always available even when the
      // capture carried no author name at all.
      name: header.authorName ?? header.authorUsername ?? 'Unknown',
      username: header.authorUsername ?? 'unknown',
      avatar: frontmatter['og:image'] ?? undefined,
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

  return { document, warnings };
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
    authorName: opts.authorName ?? fromAuthor.name ?? fromTitle.name ?? null,
    publishedAt: null,
  };
}

interface ParsedBlocks {
  blocks: ArticleBlock[];
  links: ArticleLink[];
  images: ArticleImage[];
}

function parseBlocks(body: string, documentTitle: string, warnings: string[]): ParsedBlocks {
  const lines = body.split('\n');
  const blocks: ArticleBlock[] = [];
  const links: ArticleLink[] = [];
  const images: ArticleImage[] = [];

  const seenLinks = new Set<string>();
  const seenImages = new Set<string>();

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
    const imageId = `img_${hash32(src)}`;
    const image: ArticleImage = {
      imageId,
      r2Key: null,
      sourceUrl: src,
      altText: altText?.trim() || undefined,
      // SPEC §10 — `external_fallback` is the honest state until the media
      // pipeline downloads and stores the bytes in R2.
      status: 'external_fallback',
    };
    images.push(image);
    return imageId;
  };

  /** Inline `[text](href)` / bare URLs: keep the text, record the target. */
  const inline = (text: string): string => {
    let out = text.replace(INLINE_LINK_RE, (_m, label: string, href: string) => {
      addLink(href, label);
      return label;
    });
    out = out.replace(BARE_URL_RE, (_m, href: string) => {
      addLink(href, href);
      return href;
    });
    return out.trim();
  };

  let index = 0;
  let sawProse = false;
  /** Consecutive items of the same kind collapse into one list block (SPEC §9.2). */
  let listBuffer: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!listBuffer) return;
    blocks.push({ type: 'list', ordered: listBuffer.ordered, items: listBuffer.items });
    listBuffer = null;
  };

  const pushParagraph = (raw: string) => {
    const text = inline(raw);
    if (text) {
      sawProse = true;
      blocks.push({ type: 'paragraph', text });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // --- fenced code (SPEC §9.2 code, §9.3 "尽量保留代码块") ------------------
    const fence = FENCE_RE.exec(line.trim());
    if (fence) {
      flushList();
      const language = fence[1] || undefined;
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
      flushList();
      const [, src = '', altText = '', href = ''] = linked;
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
      const text = inline(heading[2] ?? '');

      // The capture's own `# Title` duplicates `document.title`. SPEC §9.1 keeps
      // the title in one place, so a leading h1 that repeats it is dropped rather
      // than rendered twice. The test is "no prose yet", not "no blocks yet":
      // X puts a cover image above the title, and that must not defeat the check.
      // NB: advance first. An earlier version `continue`d without moving `index`,
      // which was harmless while the condition never matched and hung the worker
      // the moment it did.
      if (rawLevel === 1 && !sawProse && text === documentTitle) {
        index += 1;
        continue;
      }

      if (text) {
        sawProse = true;
        blocks.push({
          type: 'heading',
          level: Math.min(rawLevel, MAX_HEADING_LEVEL) as 1 | 2 | 3,
          text,
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
      const text = inline(quoted.join(' ').trim());
      if (text) {
        sawProse = true;
        blocks.push({ type: 'quote', text });
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

  return { blocks, links, images };
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
