/**
 * SPEC §38 Phase 3 — raw → ArticleDocument → D1.
 *
 * Acceptance (SPEC §38 / §39 Parser):
 *   - title, author, date, paragraphs, images, links
 *
 * SPEC §27 — the whole reason the crawl keeps raw output is that this step must
 * never touch X again. Re-parsing is a local operation over `articles/{id}/raw/`,
 * so bumping PARSER_VERSION and re-running fixes every article without spending
 * Browser Run time or asking X for anything.
 *
 * SPEC §28 — parsing is versioned too, but by *parser* version, not source
 * version. A source change is already a new crawl version; a parser change
 * produces a new ArticleDocument for the same capture.
 */

import { R2_PATHS } from '../types/article-document';
import type { ArticleDocument } from '../types/article-document';
import { countWords, documentToPlainText } from '../types/article-document';
import { parseMarkdownToDocument } from '../parser/markdown';
import { segmentCjk } from '../lib/cjk';
import { log } from '../lib/logger';
import { sha256Hex } from '../lib/hash';
import { newId } from '../lib/ids';
import { getArticleById } from '../db/articles';
import { writeArticleDocument } from '../services/archive';
import { readRawArchive } from './crawl';

/**
 * SPEC §27 — the Parser version. Bump when the block extraction changes
 * materially; existing articles can then be re-parsed from their raw archive.
 *
 * v2: X's author chip (linked avatar + name + date) is recognised as metadata
 *     instead of being published as a body figure, per SPEC §7.2.
 * v3: the recovered avatar is written back to the article row. The crawl had put
 *     the cover image there from og:image, so the byline showed a stock photo.
 * v4: the author name prefers fresh extraction over the stored column, and no
 *     longer falls back to X's <title>, which is "Headline | Author on X" and
 *     produced bylines like "Some Headline | Some Author".
 * v5: image ids are scoped to the article. Keying them on the source URL alone
 *     made the same image collide across two Articles — the same avatar, or a
 *     syndicated screenshot — and SPEC §10's media_objects uses the id as its
 *     PRIMARY KEY, so the second article's media run failed on a UNIQUE
 *     violation.
 *
 * v6: a video is classified as `status: 'video'` rather than as an unarchived image.
 *     The bump matters for documents already stored: theirs were written under v5, where
 *     a video is `external_fallback`, and the media pipeline reads that state as work to
 *     do. Without a new version the idempotence check below short-circuits and those
 *     documents keep rendering the failed-image figure that claims a video "still loads
 *     from x.com". The archive holds no videos today, so nothing is actually stale — the
 *     bump is what makes that a fact rather than a coincidence.
 */
export const PARSER_VERSION = 6;

export type ParseResult = 'parsed' | 'reparsed' | 'unchanged' | 'failed';

export interface ParseOutcome {
  ok: boolean;
  result: ParseResult;
  errorCode?: 'RAW_MISSING' | 'PARSER_FAILED' | 'NOT_FOUND';
  errorMessage?: string;
  blockCount?: number;
  wordCount?: number;
  imageCount?: number;
  linkCount?: number;
  warnings?: string[];
}

export async function parseArticle(env: Env, articleId: string): Promise<ParseOutcome> {
  const article = await getArticleById(env.DB, articleId);
  if (!article) {
    return { ok: false, result: 'failed', errorCode: 'NOT_FOUND', errorMessage: `Article not found: ${articleId}` };
  }

  if (!article.raw_r2_key) {
    return {
      ok: false,
      result: 'failed',
      errorCode: 'RAW_MISSING',
      errorMessage: 'No raw archive to parse. Run the crawl first.',
    };
  }

  // SPEC §27 — an unchanged parser version over an already-parsed article is a
  // no-op. Comparing parser_version is what makes a re-parse idempotent.
  if (article.parser_version === PARSER_VERSION && article.content_r2_key) {
    const existing = await env.ARCHIVE.head(article.content_r2_key);
    if (existing) {
      return {
        ok: true,
        result: 'unchanged',
        blockCount: article.block_count,
        wordCount: article.word_count,
      };
    }
  }

  // ---- read the capture (SPEC §8, read-only; SPEC §27 raw is never rewritten)
  const archive = await readRawArchive(env.ARCHIVE, article.raw_r2_key);
  const markdown = archive.markdown;

  if (!markdown || markdown.trim().length === 0) {
    return {
      ok: false,
      result: 'failed',
      errorCode: 'RAW_MISSING',
      errorMessage: 'The raw archive has no Markdown. SPEC §7.1 requires it; the crawl may not have completed.',
    };
  }

  // ---- parse -----------------------------------------------------------------
  const capturedAt = String(archive.metadata?.capturedAt ?? new Date().toISOString());
  const { document, warnings } = parseMarkdownToDocument(markdown, {
    url: article.canonical_url,
    authorName: article.author_name,
    authorUsername: article.author_username,
    publishedAt: article.published_at ? new Date(article.published_at).toISOString() : null,
    parserVersion: PARSER_VERSION,
    capturedAt,
  });

  // SPEC §9.3 — the crawl's metadata is authoritative when the Markdown had none;
  // a Parser that dropped the title would be a silent data loss.
  if (!document.title || document.title === 'Untitled') {
    document.title = article.title || document.title;
  }

  const plainText = documentToPlainText(document);
  const words = countWords(plainText);

  // ---- write the versioned document (SPEC §8) --------------------------------
  const crawlVersion = await currentCrawlVersion(env, articleId);
  const documentKey = R2_PATHS.versionJson(articleId, crawlVersion);

  const body = stripFrontmatterForMirror(document);
  await writeArticleDocument(env.ARCHIVE, documentKey, document);
  await env.ARCHIVE.put(R2_PATHS.versionMarkdown(articleId, crawlVersion), body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });

  const contentHash = await sha256Hex(plainText);

  // ---- version bookkeeping (SPEC §27 / §28) ---------------------------------
  const existing = await env.DB.prepare(
    `SELECT id FROM article_versions WHERE article_id = ? AND version = ? AND parser_version = ?`,
  )
    .bind(articleId, crawlVersion, PARSER_VERSION)
    .first<{ id: string }>();

  if (!existing) {
    const versionRow = await env.DB.prepare(
      `SELECT source_hash FROM article_versions WHERE article_id = ? ORDER BY version DESC LIMIT 1`,
    )
      .bind(articleId)
      .first<{ source_hash: string }>();

    await env.DB.prepare(
      `INSERT INTO article_versions (id, article_id, version, parser_version, source_hash, content_hash, r2_key, captured_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
      .bind(
        newId('ver'),
        articleId,
        crawlVersion,
        PARSER_VERSION,
        versionRow?.source_hash ?? '',
        contentHash,
        documentKey,
        Date.parse(capturedAt) || Date.now(),
      )
      .run();
  }

  // ---- D1 (SPEC §12 needs the plain-text mirror for FTS) ---------------------
  // Captured before the UPDATE below, which is what decides whether the avatar stays
  // local. See the note on the bound value.
  const currentAvatar = article.author_avatar;

  await env.DB.prepare(
    `UPDATE articles
        SET content_r2_key = ?2,
            parser_version = ?3,
            block_count = ?4,
            word_count = ?5,
            fts_content = ?6,
            fts_tags = ?7,
            title = COALESCE(NULLIF(?8, ''), title),
            author_name = COALESCE(?9, author_name),
            author_username = COALESCE(?10, author_username),
            author_avatar = COALESCE(?11, author_avatar),
            fts_title = COALESCE(NULLIF(?13, ''), fts_title),
            fts_author_name = COALESCE(?9, fts_author_name),
            fts_author_username = COALESCE(?10, fts_author_username),
            updated_at = ?12
      WHERE id = ?1`,
  )
    .bind(
      articleId,
      documentKey,
      PARSER_VERSION,
      document.blocks.length,
      words,
      // SPEC §12 — the CJK-segmented form is what gets indexed, because
      // `unicode61` treats a run of Chinese as one token and `投资` would never match.
      // `fts_content` and `fts_tags` are index-only columns: nothing SELECTs them.
      segmentCjk(plainText),
      segmentCjk(await tagsTextFor(env.DB, articleId)),
      document.title,
      document.author.name,
      document.author.username,
      // SPEC §9 — the Parser is the metadata authority. The crawl's avatar came
      // from og:image, which on an X Article is the cover image, not a face.
      //
      // The chip's avatar is correct but remote, and once the media job has
      // archived the portrait the column holds a local /media/... path. Writing the
      // remote URL back over it would put the CDN dependency SPEC §10 just removed
      // straight back, and it would happen on every re-parse. So an archived avatar
      // wins, exactly as it does against the crawl.
      currentAvatar?.startsWith('/media/') ? null : (document.author.avatar ?? null),
      Date.now(),
      // The same segmenting for the title, kept in step with the three columns above
      // by binding the same values again — one extra parameter rather than a second
      // code path that could drift from the first.
      segmentCjk(document.title),
    )
    .run();

  for (const warning of warnings) {
    log.warn('parse_failed', { article_id: articleId, error_code: 'PARSER_FAILED', error_message: warning });
  }

  log.info('parse_success', {
    article_id: articleId,
    parser_version: PARSER_VERSION,
    block_count: document.blocks.length,
    word_count: words,
    image_count: document.images.length,
    link_count: document.links.length,
    warnings: warnings.length,
  });

  return {
    ok: true,
    result: article.content_r2_key ? 'reparsed' : 'parsed',
    blockCount: document.blocks.length,
    wordCount: words,
    imageCount: document.images.length,
    linkCount: document.links.length,
    warnings,
  };
}

/** The latest crawl version supplies the directory for the parsed document. */
async function currentCrawlVersion(env: Env, articleId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MAX(version) AS v FROM article_versions WHERE article_id = ?`,
  )
    .bind(articleId)
    .first<{ v: number | null }>();
  return row?.v ?? 1;
}

/** SPEC §12 — tag text is mirrored into D1 so FTS can match it. */
async function tagsTextFor(db: D1Database, articleId: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = ? ORDER BY t.name`,
    )
    .bind(articleId)
    .all<{ name: string }>();
  return results.map((r) => r.name).join(' ');
}

/** SPEC §8 — a Markdown mirror of the versioned document, for diffing later. */
function stripFrontmatterForMirror(doc: ArticleDocument): string {
  const lines = [`# ${doc.title}`, '', `> @${doc.author.username} · ${doc.publishedAt ?? ''}`, ''];

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'quote':
        lines.push(`> ${block.text}`, '');
        break;
      case 'list':
        block.items.forEach((item, i) => lines.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`));
        lines.push('');
        break;
      case 'code':
        lines.push('```', block.code, '```', '');
        break;
      case 'paragraph':
        lines.push(block.text, '');
        break;
      default:
        break;
    }
  }

  lines.push('---', `Source: ${doc.source.url}`);
  return lines.join('\n');
}
