/**
 * SPEC §6 state machine + SPEC §16.3 admin actions + SPEC §37 governance.
 *
 * Pulled forward from Phase 3 because the public site needs published rows, and
 * the alternative — publishing by hand-writing SQL — would leave the curation
 * audit trail (SPEC §11.9) empty and untrustworthy.
 *
 * Every transition writes a `curation_events` row. There is no silent mutation.
 */

import { getArticleById, setArticleStatus, setDisplayMode } from '../db/articles';
import { listCategories } from '../db/categories';
import { recordEvent } from '../db/events';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import type { ArticleStatus, DisplayMode } from '../jobs/types';

/** SPEC §6 — allowed article state transitions. Anything else is a bug, not a UX quirk. */
export const TRANSITIONS: Record<ArticleStatus, ArticleStatus[]> = {
  pending: ['fetching', 'review', 'archived', 'takedown', 'rejected', 'failed'],
  fetching: ['fetched', 'failed', 'archived', 'takedown'],
  fetched: ['parsing', 'review', 'failed', 'archived', 'takedown'],
  parsing: ['review', 'failed', 'archived', 'takedown'],
  review: ['published', 'rejected', 'archived', 'takedown', 'parsing'],
  published: ['archived', 'takedown', 'review'],
  rejected: ['review', 'archived', 'takedown'],
  archived: ['review', 'takedown'],
  takedown: ['archived', 'review'],
  failed: ['pending', 'archived', 'takedown'],
};

function assertTransition(from: ArticleStatus, to: ArticleStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new AppError('BAD_REQUEST', `Illegal transition: ${from} → ${to}`, 409);
  }
}

async function loadArticle(env: Env, articleId: string) {
  const article = await getArticleById(env.DB, articleId);
  if (!article) throw new AppError('NOT_FOUND', `Article not found: ${articleId}`, 404);
  return article;
}

/** SPEC §16.3 — Publish. The editor has the final say (SPEC §4.7). */
export async function publishArticle(env: Env, articleId: string, actor: string, note?: string): Promise<void> {
  const article = await loadArticle(env, articleId);
  assertTransition(article.status as ArticleStatus, 'published');
  if (!article.raw_r2_key || !article.content_r2_key || article.block_count < 1 || article.display_mode === 'takedown') {
    throw new AppError('BAD_REQUEST', 'Article must have a parsed body before publication.', 409);
  }

  await setArticleStatus(env.DB, articleId, 'published');
  await recordEvent(env.DB, articleId, 'publish', actor, note);
  log.info('publish', { article_id: articleId, actor, previous_status: article.status });
}

export async function rejectArticle(env: Env, articleId: string, actor: string, note?: string): Promise<void> {
  const article = await loadArticle(env, articleId);
  assertTransition(article.status as ArticleStatus, 'rejected');

  await setArticleStatus(env.DB, articleId, 'rejected');
  await recordEvent(env.DB, articleId, 'reject', actor, note);
}

export async function archiveArticle(env: Env, articleId: string, actor: string, note?: string): Promise<void> {
  const article = await loadArticle(env, articleId);
  assertTransition(article.status as ArticleStatus, 'archived');

  await setArticleStatus(env.DB, articleId, 'archived');
  await recordEvent(env.DB, articleId, 'archive', actor, note);
}

export async function restoreArticle(env: Env, articleId: string, actor: string): Promise<void> {
  const article = await loadArticle(env, articleId);
  await setArticleStatus(env.DB, articleId, 'review');
  await recordEvent(env.DB, articleId, 'restore', actor, `from ${article.status}`);
}

/** SPEC §37 — Takedown. Removes the body from the public site immediately. */
export async function takedownArticle(
  env: Env,
  articleId: string,
  actor: string,
  reason: string,
): Promise<void> {
  await loadArticle(env, articleId);

  await setDisplayMode(env.DB, articleId, 'takedown', reason);
  await setArticleStatus(env.DB, articleId, 'takedown');
  await recordEvent(env.DB, articleId, 'takedown', actor, reason);
  log.info('publish', { article_id: articleId, actor, action: 'takedown', reason });
}

/**
 * SPEC §37 — Restore visibility without republishing the status.
 *
 * Takedown overwrites the status, so "undo" has to put something back. The
 * assumption is that a takedown only ever applied to something an editor had
 * already published, so undo returns it to `published`. Restoring any other
 * status leaves it untouched — a rejected article must not silently reappear.
 */
export async function restoreDisplay(env: Env, articleId: string, actor: string, mode: DisplayMode): Promise<void> {
  const article = await loadArticle(env, articleId);
  if (mode === 'takedown') throw new AppError('BAD_REQUEST', 'Use the takedown action for that', 400);

  await setDisplayMode(env.DB, articleId, mode);
  if (article.status === 'takedown') await setArticleStatus(env.DB, articleId, 'published');
  await recordEvent(env.DB, articleId, 'restore', actor, `display_mode=${mode}`);
}

/** SPEC §15 / §16.3 — Editor's Pick. */
export async function setFeatured(env: Env, articleId: string, actor: string, featured: boolean): Promise<void> {
  await loadArticle(env, articleId);
  const now = Date.now();

  await env.DB.prepare(`UPDATE articles SET featured = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(articleId, featured ? 1 : 0, now)
    .run();
  await recordEvent(env.DB, articleId, featured ? 'featured' : 'unfeatured', actor);
}

/**
 * SPEC §16.3 — the submitted form value turned into the stored value.
 *
 * Pure, because this is where the decisions live and none of them need a database: an
 * empty submission is the *clear* action rather than a category called "", a known id
 * passes through, and anything else is refused by name.
 *
 * The refusal is the point. `editor_category_id` is a soft reference — nothing in the
 * schema declares a foreign key and every read joins through it — so a typo would not
 * fail loudly. It would store a value no join can match, the article would silently
 * reappear as uncategorised, and the `category_override` audit event would name a
 * category that does not exist. Nothing on the article page reports any of that, which
 * is why the check lives here and not in whichever form happened to submit the value.
 */
export function resolveCategoryOverride(
  categories: ReadonlyArray<{ id: string }>,
  submitted: string | null,
): string | null {
  const id = (submitted ?? '').trim();
  if (id === '') return null;
  if (!categories.some((c) => c.id === id)) {
    throw new AppError('BAD_REQUEST', `Unknown category: ${id}`, 400);
  }
  return id;
}

/**
 * SPEC §16.3 — Edit category. The editor override always wins over the AI suggestion.
 *
 * Passing `null` clears the override, which is how an editor hands the article back to
 * whatever the AI proposed — the two columns are read as
 * `COALESCE(editor_category_id, category_id)`. The category list is only fetched when
 * there is something to check, so clearing stays a single write.
 */
export async function overrideCategory(
  env: Env,
  articleId: string,
  actor: string,
  categoryId: string | null,
): Promise<void> {
  await loadArticle(env, articleId);

  const resolved = resolveCategoryOverride(categoryId === null ? [] : await listCategories(env.DB), categoryId);
  const now = Date.now();

  await env.DB.prepare(`UPDATE articles SET editor_category_id = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(articleId, resolved, now)
    .run();
  await recordEvent(env.DB, articleId, 'category_override', actor, resolved ?? 'none');
}

/** SPEC §16.3 — Edit summary. The editor override always wins over the AI summary. */
export async function overrideSummary(env: Env, articleId: string, actor: string, summary: string): Promise<void> {
  await loadArticle(env, articleId);
  const now = Date.now();

  await env.DB.prepare(`UPDATE articles SET editor_summary = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(articleId, summary, now)
    .run();
  await recordEvent(env.DB, articleId, 'summary_override', actor);
}

/** SPEC §14 — stores the scores computed by the ranking refresh (SPEC §21 cron, Phase 6). */
export async function applyRankingScores(
  env: Env,
  articleId: string,
  scores: { popularity: number; velocity: number; quality: number; editor: number; final: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE articles
        SET popularity_score = ?2, velocity_score = ?3, quality_score = ?4,
            editor_score = ?5, final_score = ?6, updated_at = ?7
      WHERE id = ?1`,
  )
    .bind(
      articleId,
      scores.popularity,
      scores.velocity,
      scores.quality,
      scores.editor,
      scores.final,
      Date.now(),
    )
    .run();
}
