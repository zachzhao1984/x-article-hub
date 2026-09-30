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
    expect(rankingWeights('{"popularity":0.6,"velocity":0.2,"quality":0.15,"editor":0.05}')).toEqual({
      popularity: 0.6,
      velocity: 0.2,
      quality: 0.15,
      editor: 0.05,
    });
  });

  it('renormalizes a partial or non-normalized config to sum to 1', () => {
    const weights = rankingWeights('{"popularity":3,"velocity":1,"quality":0,"editor":0}');
    expect(weights.popularity).toBeCloseTo(0.75);
    expect(weights.velocity).toBeCloseTo(0.25);
    expect(weights.popularity + weights.velocity + weights.quality + weights.editor).toBeCloseTo(1);
  });

  it('ignores negative and non-numeric values instead of falling back per key', () => {
    const weights = rankingWeights('{"popularity":-5,"velocity":1,"quality":"x","editor":null}');
    expect(weights.popularity).toBe(0);
    expect(weights.velocity).toBe(1);
    expect(weights.quality).toBe(0);
    expect(weights.editor).toBe(0);
  });

  it('falls back when every weight is unusable', () => {
    expect(rankingWeights('{"popularity":0,"velocity":0,"quality":0,"editor":0}')).toEqual(DEFAULT_RANKING_WEIGHTS);
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
