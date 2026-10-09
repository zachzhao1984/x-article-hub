/**
 * SPEC §14 — ranking.
 *
 * Two scored signals plus a human override, deliberately not collapsed into one:
 *
 *   popularity  log-compressed engagement magnitude
 *   quality     AI assessment (SPEC §14.3 — never decides publication)
 *   editor      a human override, which is not a score the pipeline computes
 *
 * combined by configurable weights into `final_score` (SPEC §14.4).
 *
 * `velocity` used to be a third signal here and is removed. It was the basis of the
 * `/rising` board, which no longer exists, and it left `final_score` with it — see the note
 * in src/config/ranking.ts.
 *
 * SPEC §14.1 requires log compression because a 10k-like article must not
 * permanently erase every article published after it.
 */

import { POPULARITY_WEIGHTS, type RankingWeights } from '../config/ranking';

export interface Metrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  views: number;
  capturedAt: number;
}

export const ZERO_METRICS: Metrics = {
  likes: 0,
  reposts: 0,
  replies: 0,
  quotes: 0,
  bookmarks: 0,
  views: 0,
  capturedAt: 0,
};

/** SPEC §11.7 — metrics may be partially unavailable; every field defaults to 0. */
export function metricsFromRow(row: Record<string, unknown> | null | undefined): Metrics {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    likes: num(row?.likes),
    reposts: num(row?.reposts),
    replies: num(row?.replies),
    quotes: num(row?.quotes),
    bookmarks: num(row?.bookmarks),
    views: num(row?.views),
    capturedAt: num(row?.captured_at ?? row?.capturedAt),
  };
}

/**
 * SPEC §14.1 — weighted log of engagement. Log, not raw counts, so a single
 * viral post does not flatten the scale.
 */
export function rawPopularity(m: Metrics): number {
  return (
    POPULARITY_WEIGHTS.likes * Math.log(m.likes + 1) +
    POPULARITY_WEIGHTS.reposts * Math.log(m.reposts + 1) +
    POPULARITY_WEIGHTS.replies * Math.log(m.replies + 1) +
    POPULARITY_WEIGHTS.quotes * Math.log(m.quotes + 1) +
    POPULARITY_WEIGHTS.bookmarks * Math.log(m.bookmarks + 1) +
    POPULARITY_WEIGHTS.views * Math.log(m.views + 1)
  );
}

/**
 * SPEC §14.1 — min-max normalization to 0..100 across the candidate set.
 * A single-article set has no spread, so it scores 0 rather than an arbitrary 100.
 */
export function normalizeScores(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0);
  return values.map((v) => ((v - min) / (max - min)) * 100);
}

/** SPEC §14.4 — weights come from config, never from a literal in this file. */
export function combineScores(
  scores: { popularity: number; quality: number; editor: number },
  weights: RankingWeights,
): number {
  return (
    weights.popularity * scores.popularity +
    weights.quality * scores.quality +
    weights.editor * scores.editor
  );
}

/** SPEC §14.3 — quality comes from AI but is clamped; a model must not be able to inject NaN. */
export function clampQuality(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
