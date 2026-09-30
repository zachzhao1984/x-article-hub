import { describe, expect, it } from 'vitest';
import {
  clampQuality,
  combineScores,
  metricsFromRow,
  normalizeScores,
  rawPopularity,
  rawVelocity,
  ZERO_METRICS,
} from '../src/ranking/score';
import { DEFAULT_RANKING_WEIGHTS } from '../src/config/ranking';

const HOUR = 3_600_000;

describe('rawPopularity (SPEC §14.1)', () => {
  it('is zero with no engagement', () => {
    expect(rawPopularity({ ...ZERO_METRICS })).toBe(0);
  });

  it('compresses magnitude so a viral post cannot flatten the scale', () => {
    const small = rawPopularity({ ...ZERO_METRICS, likes: 100 });
    const huge = rawPopularity({ ...ZERO_METRICS, likes: 1_000_000 });
    // 10,000x the likes must not be anywhere near 10,000x the score.
    expect(huge / small).toBeLessThan(10);
  });

  it('weights likes above replies', () => {
    const likes = rawPopularity({ ...ZERO_METRICS, likes: 1000 });
    const replies = rawPopularity({ ...ZERO_METRICS, replies: 1000 });
    expect(likes).toBeGreaterThan(replies);
  });

  it('is monotonic in every metric', () => {
    for (const key of ['likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'views'] as const) {
      const low = rawPopularity({ ...ZERO_METRICS, [key]: 10 });
      const high = rawPopularity({ ...ZERO_METRICS, [key]: 1000 });
      expect(high, key).toBeGreaterThan(low);
    }
  });
});

describe('normalizeScores (SPEC §14.1)', () => {
  it('maps a set to 0..100', () => {
    expect(normalizeScores([0, 50, 100])).toEqual([0, 50, 100]);
  });

  it('returns all zeros when there is no spread, rather than a fake 100', () => {
    expect(normalizeScores([7, 7, 7])).toEqual([0, 0, 0]);
  });

  it('handles an empty set', () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe('rawVelocity (SPEC §14.2)', () => {
  const now = 1_700_000_000_000;

  it('is zero without a previous sample', () => {
    expect(rawVelocity({ ...ZERO_METRICS, likes: 10, capturedAt: now }, null, now)).toBe(0);
  });

  it('is zero when the previous sample has no timestamp', () => {
    expect(rawVelocity({ ...ZERO_METRICS, likes: 10, capturedAt: now }, { ...ZERO_METRICS }, now)).toBe(0);
  });

  it('is positive when engagement grows', () => {
    const prev = { ...ZERO_METRICS, likes: 100, capturedAt: now - 6 * HOUR };
    const cur = { ...ZERO_METRICS, likes: 400, views: 10_000, capturedAt: now };
    expect(rawVelocity(cur, prev, now)).toBeGreaterThan(0);
  });

  it('never goes negative when a metric regresses', () => {
    const prev = { ...ZERO_METRICS, likes: 500, capturedAt: now - 6 * HOUR };
    const cur = { ...ZERO_METRICS, likes: 100, capturedAt: now };
    expect(rawVelocity(cur, prev, now)).toBe(0);
  });

  it('ranks faster growth above slower growth', () => {
    const prev = { ...ZERO_METRICS, likes: 0, capturedAt: now - 6 * HOUR };
    const slow = rawVelocity({ ...ZERO_METRICS, likes: 10, capturedAt: now }, prev, now);
    const fast = rawVelocity({ ...ZERO_METRICS, likes: 5000, capturedAt: now }, prev, now);
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('combineScores (SPEC §14.4)', () => {
  const scores = { popularity: 100, velocity: 100, quality: 100, editor: 100 };

  it('returns the weighted blend', () => {
    expect(combineScores(scores, { popularity: 0.25, velocity: 0.25, quality: 0.25, editor: 0.25 })).toBe(100);
  });

  it('follows the configured weights rather than a hard-coded formula', () => {
    expect(
      combineScores({ popularity: 100, velocity: 0, quality: 0, editor: 0 }, { popularity: 0.4, velocity: 0.3, quality: 0.2, editor: 0.1 }),
    ).toBeCloseTo(40);
  });

  it('uses the SPEC §14.4 defaults', () => {
    expect(combineScores(scores, DEFAULT_RANKING_WEIGHTS)).toBeCloseTo(100);
  });
});

describe('clampQuality (SPEC §14.3)', () => {
  it('clamps into 0..100', () => {
    expect(clampQuality(150)).toBe(100);
    expect(clampQuality(-5)).toBe(0);
    expect(clampQuality(72)).toBe(72);
  });

  it('treats a missing or non-numeric AI score as zero', () => {
    expect(clampQuality(null)).toBe(0);
    expect(clampQuality(undefined)).toBe(0);
    expect(clampQuality(Number.NaN)).toBe(0);
  });
});

describe('metricsFromRow (SPEC §11.7)', () => {
  it('reads a snake_case database row', () => {
    expect(metricsFromRow({ likes: 5, reposts: 2, captured_at: 100 })).toMatchObject({ likes: 5, reposts: 2, capturedAt: 100 });
  });

  it('defaults every absent metric to zero rather than null', () => {
    expect(metricsFromRow({})).toEqual(ZERO_METRICS);
    expect(metricsFromRow(null)).toEqual(ZERO_METRICS);
  });

  it('rejects negative and non-numeric values', () => {
    expect(metricsFromRow({ likes: -3, views: 'many' }).likes).toBe(0);
    expect(metricsFromRow({ views: 'many' }).views).toBe(0);
  });
});
