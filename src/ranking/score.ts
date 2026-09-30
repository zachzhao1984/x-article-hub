/**
 * SPEC §14 — ranking.
 *
 * Three independent signals, deliberately not collapsed into one:
 *
 *   popularity  log-compressed engagement magnitude
 *   velocity    engagement rate over time
 *   quality     AI assessment (SPEC §14.3 — never decides publication)
 *
 * combined by configurable weights into `final_score` (SPEC §14.4).
 *
 * SPEC §14.1 requires log compression because a 10k-like article must not
 * permanently erase every article published after it.
 */

import { POPULARITY_WEIGHTS, VELOCITY_WINDOWS_MS, type RankingWeights } from '../config/ranking';

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

/**
 * SPEC §14.2 — velocity over multiple windows.
 *
 * Windows are averaged rather than maxed: SPEC §14.2 warns against letting one
 * short spike dominate. An article with a single burst reads as "fast" for a
 * moment and then settles, which is the intended behaviour for /rising.
 */
export function rawVelocity(current: Metrics, previous: Metrics | null, now: number): number {
  if (!previous || !previous.capturedAt || !current.capturedAt) return 0;

  const deltas = {
    likes: Math.max(0, current.likes - previous.likes),
    reposts: Math.max(0, current.reposts - previous.reposts),
    views: Math.max(0, current.views - previous.views),
  };

  const rates: number[] = [];
  for (const window of Object.values(VELOCITY_WINDOWS_MS)) {
    // A delta older than the window is spread over the window, not over 0 seconds.
    const observedMs = Math.max(current.capturedAt - previous.capturedAt, window);
    const hours = observedMs / 3_600_000;
    rates.push(
      (deltas.likes / hours) * 0.4 + (deltas.reposts / hours) * 0.35 + (deltas.views / hours) * 0.25,
    );
  }

  void now;
  return rates.reduce((sum, r) => sum + r, 0) / rates.length;
}

/** SPEC §14.4 — weights come from config, never from a literal in this file. */
export function combineScores(
  scores: { popularity: number; velocity: number; quality: number; editor: number },
  weights: RankingWeights,
): number {
  return (
    weights.popularity * scores.popularity +
    weights.velocity * scores.velocity +
    weights.quality * scores.quality +
    weights.editor * scores.editor
  );
}

/** SPEC §14.3 — quality comes from AI but is clamped; a model must not be able to inject NaN. */
export function clampQuality(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
