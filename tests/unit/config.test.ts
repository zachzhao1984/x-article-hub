import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKING_WEIGHTS, rankingWeights } from '../../src/config/ranking';
import { isJobMessage } from '../../src/jobs/types';

describe('rankingWeights', () => {
  it('falls back to the SPEC §14.4 defaults when unset', () => {
    expect(rankingWeights(undefined)).toEqual(DEFAULT_RANKING_WEIGHTS);
  });

  it('falls back when the config is not valid JSON', () => {
    expect(rankingWeights('{not json')).toEqual(DEFAULT_RANKING_WEIGHTS);
  });

  it('reads the weights from config instead of hard-coding them', () => {
    // `toBeCloseTo`, not `toEqual`: normalizing divides by a sum, so 0.6 comes back as
    // 0.6000000000000001. The exact-equality version passed only while the fourth key made
    // the arithmetic land on representable values.
    const weights = rankingWeights('{"popularity":0.6,"quality":0.3,"editor":0.1}');
    expect(weights.popularity).toBeCloseTo(0.6);
    expect(weights.quality).toBeCloseTo(0.3);
    expect(weights.editor).toBeCloseTo(0.1);
  });

  it('drops a stale velocity key rather than failing on it', () => {
    // The var on the deployment still carries `"velocity":0.3` from the four-signal model.
    // Deploying before that var is edited must not produce a four-key weight object, and
    // must not fall back either — the three surviving keys are all valid.
    const weights = rankingWeights('{"popularity":0.4,"velocity":0.3,"quality":0.2,"editor":0.1}');
    expect(weights).not.toHaveProperty('velocity');
    expect(weights.popularity + weights.quality + weights.editor).toBeCloseTo(1);
  });

  it('renormalizes a partial or non-normalized config to sum to 1', () => {
    // Three keys now, not four — `velocity` left the model with the /rising board.
    const weights = rankingWeights('{"popularity":3,"quality":1,"editor":0}');
    expect(weights.popularity).toBeCloseTo(0.75);
    expect(weights.quality).toBeCloseTo(0.25);
    expect(weights.popularity + weights.quality + weights.editor).toBeCloseTo(1);
  });

  it('falls back when every remaining key is unusable', () => {
    // The per-key rule is "an unusable value contributes 0", but a set with no usable value
    // at all has no proportions to normalize, so it falls back to the defaults rather than
    // returning all zeros — an all-zero weight object would silently score every article 0.
    const weights = rankingWeights('{"popularity":-5,"quality":"x","editor":null}');
    expect(weights).toEqual(DEFAULT_RANKING_WEIGHTS);
  });

  it('keeps the usable keys when only some are unusable', () => {
    const weights = rankingWeights('{"popularity":-5,"quality":3,"editor":1}');
    expect(weights.popularity).toBe(0);
    expect(weights.quality).toBeCloseTo(0.75);
    expect(weights.editor).toBeCloseTo(0.25);
  });

  it('falls back when every weight is unusable', () => {
    expect(rankingWeights('{"popularity":0,"quality":0,"editor":0}')).toEqual(DEFAULT_RANKING_WEIGHTS);
  });
});

describe('isJobMessage', () => {
  const valid = { jobId: 'job_1', articleId: 'art_1', type: 'crawl', attempt: 1, createdAt: 1 };

  it('accepts a well-formed message', () => {
    expect(isJobMessage(valid)).toBe(true);
  });

  it('accepts every declared job type', () => {
    for (const type of ['crawl', 'parse', 'ai', 'metrics', 'reindex']) {
      expect(isJobMessage({ ...valid, type })).toBe(true);
    }
  });

  it.each([
    [{ ...valid, type: 'nuke' }],
    [{ ...valid, jobId: 42 }],
    [{ ...valid, attempt: '1' }],
    [null],
    ['string'],
    [undefined],
    [{}],
  ])('rejects a malformed message: %j', (message) => {
    expect(isJobMessage(message)).toBe(false);
  });
});
