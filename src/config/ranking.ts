/**
 * SPEC §14 — ranking configuration.
 *
 * SPEC §14.4 is explicit: "不要把权重写死在代码里" (do not hard-code the weights).
 * They come from the `RANKING_WEIGHTS_JSON` var so an editor can retune ranking
 * by editing config and redeploying, without a code change.
 *
 * Phase 1 only *defines* this config. The score computation itself is Phase 6
 * (metrics are not collected until then), but keeping it here now means the
 * weights have exactly one home from day one.
 */

export interface RankingWeights {
  popularity: number;
  velocity: number;
  quality: number;
  editor: number;
}

/** SPEC §14.1 — log-compressed engagement weights. */
export const POPULARITY_WEIGHTS = {
  likes: 0.3,
  reposts: 0.25,
  replies: 0.15,
  quotes: 0.1,
  bookmarks: 0.1,
  views: 0.1,
} as const;

/** SPEC §14.2 — multiple windows avoid a single spike dominating velocity. */
export const VELOCITY_WINDOWS_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  popularity: 0.4,
  velocity: 0.3,
  quality: 0.2,
  editor: 0.1,
};

export function rankingWeights(raw: string | undefined): RankingWeights {
  if (!raw) return DEFAULT_RANKING_WEIGHTS;
  try {
    const parsed = JSON.parse(raw) as Partial<RankingWeights>;
    return normalizeWeights({ ...DEFAULT_RANKING_WEIGHTS, ...parsed });
  } catch {
    return DEFAULT_RANKING_WEIGHTS;
  }
}

const WEIGHT_KEYS: Array<keyof RankingWeights> = ['popularity', 'velocity', 'quality', 'editor'];

/**
 * Drop anything that is not a positive finite number, then scale so the weights
 * sum to 1. An unusable entry must contribute 0 — falling back to the default
 * for one key while renormalizing the others would silently skew every score.
 */
function normalizeWeights(weights: RankingWeights): RankingWeights {
  const out = { popularity: 0, velocity: 0, quality: 0, editor: 0 };
  let sum = 0;

  for (const key of WEIGHT_KEYS) {
    const value = (weights as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = value;
      sum += value;
    }
  }

  if (sum <= 0) return DEFAULT_RANKING_WEIGHTS;

  for (const key of WEIGHT_KEYS) out[key] = out[key] / sum;
  return out;
}
