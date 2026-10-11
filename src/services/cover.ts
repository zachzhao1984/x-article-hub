/**
 * Generated covers for articles that have no body image to use.
 *
 * ## Why this exists
 *
 * The card's cover is the article's first `body` image (SPEC §15), so an article whose
 * document has no figures has no cover at all — 77 of the first hundred imported articles
 * were in that state. The card then renders without one, which is honest but makes an
 * image-less post indistinguishable from an article whose media simply failed.
 *
 * A generated image is not the article's own figure, and the schema says so: the row is
 * `kind = 'cover'`, it carries no position in the flow, and a re-parse ignores it. What it
 * is, is a stand-in that gives the card something to show.
 *
 * ## Why Workers AI rather than an external image API
 *
 * The `AI` binding is already configured (SPEC §32) and needs no key to be managed or
 * rotated, which matters because the alternative is another secret in the deployment that
 * can silently expire. SPEC §32's rule that the model id must not be treated as permanent
 * is honoured below: the id is a single constant, and a model that disappears is a clear
 * error rather than a mystery.
 *
 * ## The prompt is derived, never arbitrary
 *
 * SPEC §13.4 caps what a model sees because the input is someone else's writing. Only the
 * title and the summary are used here — both already stored, both already plain text — and
 * the whole thing is capped to `AI_CONFIG.maxInputChars` on the way in. The prompt asks for
 * an abstract editorial illustration rather than anything literal, which is the honest
 * framing: the image is not a depiction of the article, it is a visual placeholder.
 */

import { AI_CONFIG } from '../config/ai';
import { log } from '../lib/logger';
import { newId } from '../lib/ids';
import { R2_PATHS } from '../types/article-document';
import { imageDimensions } from '../lib/image-size';
import { sniffImageType } from './media';

/**
 * SPEC §32 — the model id is one value, not a permanent standard.
 *
 * `flux-1-schnell` is chosen because it is the fastest text-to-image model on Workers AI
 * and this runs once per article rather than interactively. If it is retired the failure is
 * a clear `MODEL_UNAVAILABLE` rather than a silent no-op, which is what a hard-coded id
 * that no longer exists would otherwise produce.
 */
export const COVER_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export type CoverErrorCode = 'MODEL_UNAVAILABLE' | 'EMPTY_IMAGE' | 'INVALID_IMAGE' | 'NOT_FOUND';

/**
 * How many covers are generated at once.
 *
 * Bounded so a fifty-article run opens a handful of model calls rather than fifty: the point
 * is to stay under the response timeout, not to remove the limit.
 */
const COVER_CONCURRENCY = 5;

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Deliberately not `Promise.all` over everything: the caller's `limit` can be 50, and firing
 * 50 model calls at once would trade one problem (a slow sequential batch) for another
 * (hammering the model endpoint). A worker-pool keeps the wall time near one call and the
 * concurrency bounded.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface CoverOutcome {
  ok: boolean;
  /** `generated` on success, `exists` when a cover was already stored. */
  result: 'generated' | 'exists' | 'failed';
  imageId?: string;
  r2Key?: string;
  bytes?: number;
  errorCode?: CoverErrorCode;
  errorMessage?: string;
}

interface ArticleRow {
  id: string;
  title: string | null;
  category_name: string | null;
}

/**
 * Build the text-to-image prompt from the article's category.
 *
 * Deliberately not the article's title or body. The title was tried and the model drew it as
 * literal text into the image (see the note below); the body would produce a scene rather
 * than a cover. The category is the one field that names a visual register without naming
 * anything a model would try to spell.
 *
 * Exported because the prompt's wording is the part most likely to need tuning, and a test
 * asserting the property that matters — that no title reaches the model — is worth more than
 * one asserting a particular string literal.
 */
export function buildCoverPrompt(article: { categoryName: string | null }): string {
  const category = (article.categoryName ?? '').trim();

  // The article's title is deliberately **not** put into the prompt.
  //
  // It was, and flux drew it as literal text into the image — the full title with its
  // question mark, rendered as a caption, across two different prompt wordings. The title
  // is the one field most likely to be short, quotable and punctuation-bearing, which is
  // exactly what a diffusion model turns into type. There is no negative prompt to prevent
  // it (flux refuses one, 5006), and no OCR in the pipeline to detect it and retry.
  //
  // The cover is a placeholder, so it does not need to depict the particular article — a
  // per-category palette and motif reads as deliberate where a botched title reads as
  // broken. This trades specificity for the property that actually matters on a card.
  const theme = CATEGORY_THEMES[category.toLowerCase()] ?? CATEGORY_THEMES.default!;

  return [
    'An abstract editorial illustration for a magazine cover, flat vector style, minimalist, bold simple geometric shapes, deep saturated colours.',
    `Visual theme: ${theme}`,
    // The composition instruction is load-bearing. The first covers placed the subject in a
    // band with a large empty margin above or below it, and the card crops to a wide strip
    // (SPEC §15 renders it `object-fit: cover`), so a vertical band loses its subject to the
    // crop. A wide, edge-to-edge composition survives it.
    'A wide composition that fills the entire frame, edge to edge, with no empty borders and no blank margins.',
    // Restated and specific, because this is the property that most often fails: a cover
    // with a misspelled caption is worse than no cover at all.
    'Purely pictorial. Contains absolutely no text, no words, no letters, no numbers, no captions, no titles, no typography, no labels, no writing of any kind.',
  ].join(' ');
}

/**
 * A visual brief per top-level category.
 *
 * The categories are fixed (0002), so this is a small, complete map rather than a
 * classifier: whatever an article is about, its category names the palette and the kind of
 * shapes to draw. `default` covers the categories that exist but have no entry here, and an
 * article with no category at all.
 */
const CATEGORY_THEMES: Record<string, string> = {
  ai: 'an abstract network of connected nodes and flowing lines, blues and violets, evoking computation and pattern',
  technology: 'an abstract arrangement of interlocking geometric circuits and blocks, teals and greys, evoking engineering',
  business: 'an abstract upward composition of ascending bars and shapes, greens and ambers, evoking growth and markets',
  science: 'an abstract orbital pattern of circles and ellipses, deep blues and warm highlights, evoking discovery',
  ideas: 'an abstract layered composition of organic shapes and arcs, warm reds and creams, evoking thought and culture',
  default: 'an abstract composition of balanced geometric shapes and flowing curves, a restrained modern palette',
};

/**
 * Generate and store a cover for one article.
 *
 * Idempotent by SPEC §19: a stored cover is returned rather than regenerated, so a retry or
 * a redelivery costs nothing and cannot overwrite an image an editor has already seen. The
 * `UNIQUE (article_id, kind, position)` constraint added in 0012 is what makes the row
 * single; this guard is what avoids spending a model call to discover that.
 */
export async function generateCover(env: Env, articleId: string): Promise<CoverOutcome> {
  const article = await env.DB.prepare(
    `SELECT a.id, a.title, a.excerpt, a.ai_summary, a.editor_summary,
            a.author_name, c.name AS category_name
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.id = ?1`,
  )
    .bind(articleId)
    .first<ArticleRow>();

  if (!article) {
    return { ok: false, result: 'failed', errorCode: 'NOT_FOUND', errorMessage: `Article not found: ${articleId}` };
  }

  const existing = await env.DB.prepare(
    `SELECT id, r2_key FROM media_objects
      WHERE article_id = ?1 AND kind = 'cover' AND r2_key IS NOT NULL
      LIMIT 1`,
  )
    .bind(articleId)
    .first<{ id: string; r2_key: string }>();

  if (existing) {
    return { ok: true, result: 'exists', imageId: existing.id, r2Key: existing.r2_key };
  }

  const prompt = buildCoverPrompt({ categoryName: article.category_name });

  let buffer: Uint8Array;
  try {
    // SPEC §32 — the model's input is `prompt` and `steps` only, and it is strict: sending
    // `negative_prompt` is refused outright (5006, "Additional or unevaluated properties not
    // allowed"), so the "no text" instruction has to live in the positive prompt and be
    // emphatic. That is why the wording below restates it.
    const response = await env.AI.run(COVER_MODEL, { prompt, steps: 4 });

    buffer = await readImageBytes(response as ReadableStream<Uint8Array> | { image?: string });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('ai_failed', {
      article_id: articleId,
      error_code: 'MODEL_UNAVAILABLE',
      error_message: message,
      model: COVER_MODEL,
    });
    return { ok: false, result: 'failed', errorCode: 'MODEL_UNAVAILABLE', errorMessage: message };
  }

  if (buffer.byteLength === 0) {
    return { ok: false, result: 'failed', errorCode: 'EMPTY_IMAGE', errorMessage: 'The model returned no image bytes' };
  }

  // The same sniff the media pipeline uses: a key must never misdescribe its own contents,
  // so the extension and content type come from the bytes rather than from an assumption.
  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    return {
      ok: false,
      result: 'failed',
      errorCode: 'INVALID_IMAGE',
      errorMessage: 'The model returned bytes that are not a recognised image',
    };
  }

  const key = R2_PATHS.cover(articleId, sniffed.extension);
  await env.ARCHIVE.put(key, buffer, {
    httpMetadata: {
      contentType: sniffed.mime,
      // The key is stable per article, so a regenerated cover overwrites in place and a
      // reader that already has it should not hold a stale copy — a short TTL, unlike the
      // immutable body media.
      cacheControl: 'public, max-age=86400',
    },
    customMetadata: { article_id: articleId, kind: 'cover', model: COVER_MODEL, prompt },
  });

  const dims = imageDimensions(buffer, sniffed.format);
  const now = Date.now();
  // A stable per-article id, in the same spirit as `avatarImageId`: the row is a singleton
  // per article, so a regenerated cover replaces rather than accumulates, and the id is
  // reproducible from the article alone.
  const imageId = `cv_${articleId}`;

  // `position` 0 with `kind = 'cover'` satisfies `UNIQUE (article_id, kind, position)`, so
  // a second run of this function for the same article cannot create a second row.
  await env.DB.prepare(
    `INSERT INTO media_objects
       (id, article_id, position, kind, source_url, r2_key, width, height, alt_text,
        status, content_type, byte_size, attempt_count, fetched_at, created_at, updated_at)
     VALUES (?1, ?2, 0, 'cover', ?3, ?4, ?5, ?6, ?7, 'ready', ?8, ?9, 1, ?10, ?10, ?10)
     ON CONFLICT (article_id, kind, position) DO UPDATE SET
       r2_key = excluded.r2_key,
       width = excluded.width,
       height = excluded.height,
       content_type = excluded.content_type,
       byte_size = excluded.byte_size,
       error_code = NULL,
       error_message = NULL,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      imageId,
      articleId,
      // A synthetic source URL: the column is NOT NULL and unique per article, and there is
      // no external origin to record. The scheme makes it obvious this never came from a CDN.
      `generated://cover/${articleId}`,
      key,
      dims?.width ?? null,
      dims?.height ?? null,
      article.title ? `Cover illustration for "${article.title}"` : 'Cover illustration',
      sniffed.mime,
      buffer.byteLength,
      now,
    )
    .run();

  log.info('ai_success', {
    article_id: articleId,
    model: COVER_MODEL,
    bytes: buffer.byteLength,
    action: 'cover_generated',
  });

  return { ok: true, result: 'generated', imageId, r2Key: key, bytes: buffer.byteLength };
}

/**
 * Read the model's image out of whatever shape it returned.
 *
 * Workers AI text-to-image models differ: most return a `ReadableStream` of bytes, but some
 * return `{ image: base64 }`. Both are handled because the model id is a value that can
 * change (SPEC §32), and a function that only understood one shape would fail confusingly
 * the day the other appears.
 */
async function readImageBytes(response: ReadableStream<Uint8Array> | { image?: string }): Promise<Uint8Array> {
  if (response instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = response.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  if (typeof response?.image === 'string') {
    const binary = atob(response.image);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  return new Uint8Array(0);
}

/**
 * Generate covers for every article that lacks one, newest first.
 *
 * Bounded rather than "all": a model call per article costs money and time, and an operator
 * asking for this wants the recent articles to have covers, not the whole archive in one
 * request. The caller can run it again to continue.
 *
 * ## Why the calls run concurrently
 *
 * A cover takes roughly fifteen seconds of model time, so doing five of them one after
 * another exceeds the point at which the edge gives up on the response — measured: a
 * synchronous batch of five returned `HTTP 000` after 61 seconds even though the covers
 * were generated. They are independent, so they run together instead, and the wall time
 * becomes roughly one cover rather than the sum.
 *
 * The pool is wider than the article limit can reach (`limit` is capped at 50 by the route,
 * which is the real bound), because these are model calls against Workers AI's own
 * concurrency rather than the browser quota the crawler shares.
 */
export async function generateMissingCovers(
  env: Env,
  limit: number,
): Promise<{ attempted: number; generated: number; failed: number; failures: Array<{ articleId: string; errorCode: string }> }> {
  const missing = await env.DB.prepare(
    `SELECT a.id
       FROM articles a
      WHERE NOT EXISTS (
        SELECT 1 FROM media_objects m
         WHERE m.article_id = a.id AND m.r2_key IS NOT NULL
           AND m.kind IN ('body', 'cover'))
      ORDER BY a.imported_at DESC
      LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: string }>();

  const outcomes = await mapWithConcurrency(missing.results, COVER_CONCURRENCY, async (row) => ({
    articleId: row.id,
    outcome: await generateCover(env, row.id),
  }));

  let generated = 0;
  const failures: Array<{ articleId: string; errorCode: string }> = [];
  for (const { articleId, outcome } of outcomes) {
    if (outcome.ok) {
      if (outcome.result === 'generated') generated += 1;
    } else {
      failures.push({ articleId, errorCode: outcome.errorCode ?? 'UNPREDICTABLE' });
    }
  }

  return { attempted: missing.results.length, generated, failed: failures.length, failures };
}
