/**
 * SPEC §21 — the ranking refresh, run on a cron trigger.
 *
 * ## What this is for
 *
 * `/trending` orders by `final_score`, and `final_score` is computed from data that arrives
 * asynchronously: the crawl writes an engagement snapshot, and this job turns the newest
 * snapshot per article into a score. Those are separate steps on purpose — recomputing on
 * every crawl would score each article against a slightly different candidate set as
 * crawls land one at a time, so two articles crawled seconds apart would be normalized
 * against different maxima and their scores would not be comparable.
 *
 * ## Why a candidate set and not a per-article score
 *
 * `rawPopularity` is log-compressed but unbounded, so `normalizeScores` min-max maps it to
 * 0..100 *across the set being scored*. A score is therefore only meaningful relative to
 * the articles it was computed with, which is why this reads every candidate in one pass
 * rather than updating one row at a time.
 *
 * The consequence worth stating: a single article scores 0, because `normalizeScores`
 * returns 0 when there is no spread. That is deliberate (`score.ts` says so) — one article
 * has nothing to be ranked against, and inventing 100 for it would put a lone import at the
 * top of a board it is alone on.
 *
 * ## Which articles are candidates
 *
 * Published and not taken down: the same predicate `/trending` itself queries, so a score is
 * never computed against an article the board will not show. An unpublished article's
 * popularity cannot shift what a published one scores.
 */

import { metricsFromRow, rawPopularity, normalizeScores, clampQuality, combineScores, trendingDecay, ZERO_METRICS } from "../ranking/score";
import { rankingWeights } from '../config/ranking';
import { log } from '../lib/logger';

interface CandidateRow extends Record<string, unknown> {
  id: string;
  published_at: number | null;
  imported_at: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  views: number | null;
  captured_at: number | null;
  quality_score: number | null;
  editor_score: number | null;
  featured: number | null;
}

export interface RankingRefreshResult {
  scored: number;
  /** Articles that had no metrics row at all, and were therefore scored 0 on popularity. */
  withoutMetrics: number;
  weights: { popularity: number; quality: number; editor: number };
}

/**
 * Recompute `final_score` (and its components) for every published article.
 *
 * One read, then one batched write. D1 rejects `BEGIN`/`COMMIT`, so `db.batch()` is the
 * only way to get atomicity across the writes — and it matters here, because a partially
 * applied refresh would leave the board ordering by a mixture of two candidate sets.
 */
export async function refreshRanking(env: Env): Promise<RankingRefreshResult> {
  const weights = rankingWeights(env.RANKING_WEIGHTS_JSON);

  // The newest metrics row per article, with the article's own published-and-visible
  // predicate applied here rather than after the fact. The correlated subquery on
  // `MAX(captured_at)` is the time-series read: §11.7 lets an article accumulate a row per
  // crawl, and only the latest describes the article as it is now.
  const { results } = await env.DB.prepare(
    `SELECT a.id,
            a.quality_score,
            a.editor_score,
            a.featured,
            a.published_at,
            a.imported_at,
            m.likes, m.reposts, m.replies, m.quotes, m.bookmarks, m.views, m.captured_at
       FROM articles a
       LEFT JOIN article_metrics m
         ON m.article_id = a.id
        AND m.captured_at = (SELECT MAX(m2.captured_at) FROM article_metrics m2 WHERE m2.article_id = a.id)
      WHERE a.status = 'published' AND a.display_mode != 'takedown'
      ORDER BY a.id ASC`,
  ).all<CandidateRow>();

  if (results.length === 0) {
    log.info('ranking_refresh', { scored: 0, without_metrics: 0, note: 'no published articles' });
    return { scored: 0, withoutMetrics: 0, weights };
  }

  // `metricsFromRow` already defaults every absent field to 0, which is the right input for
  // a ranking signal even though it is the wrong thing to *store* — the distinction is kept
  // at the collection end (`EngagementMetrics`) where "not found" is still distinguishable
  // from "zero", and lost deliberately here, where a missing number has to rank somewhere.
  const now = Date.now();
  const rawScores = results.map((row) => {
    const m = row.captured_at === null ? ZERO_METRICS : metricsFromRow(row);
    // Trending must respect publication time: an old viral post should not
    // permanently flatten newer articles while their engagement is still growing.
    const publishedAt = row.published_at ?? row.imported_at;
    return rawPopularity(m) * trendingDecay(publishedAt, now);
  });
  const popularity = normalizeScores(rawScores);

  const updatedAt = Date.now();
  const statements = results.map((row, i) => {
    const quality = clampQuality(row.quality_score);
    // The editor's override is a flag, not a dial: featured means 100, everything else 0.
    // Reading a stored `editor_score` would let a value that no UI can produce decide the
    // board, and `featured` is the only thing an editor can actually set.
    const editor = row.featured === 1 ? 100 : 0;
    const final = combineScores({ popularity: popularity[i] ?? 0, quality, editor }, weights);

    return env.DB.prepare(
      `UPDATE articles
          SET popularity_score = ?2, quality_score = ?3, editor_score = ?4, final_score = ?5, updated_at = ?6
        WHERE id = ?1`,
    ).bind(row.id, popularity[i] ?? 0, quality, editor, final, updatedAt);
  });

  await env.DB.batch(statements);

  const withoutMetrics = results.filter((r) => r.captured_at === null).length;
  const withMetrics = results.length - withoutMetrics;

  log.info('ranking_refresh', {
    scored: results.length,
    with_metrics: withMetrics,
    without_metrics: withoutMetrics,
    weights,
  });

  return { scored: results.length, withoutMetrics, weights };
}
