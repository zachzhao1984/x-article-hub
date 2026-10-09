import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { extractEngagement, parseCount } from '../../src/jobs/x-selectors';

/**
 * SPEC §14.1 — engagement read off the page.
 *
 * The fixture is a verbatim `page.html` from the archive:
 *   https://x.com/obie/article/2101779116056088732
 * captured 2026-10-08. Real markup, not an invented sample, because the whole difficulty
 * here is X's DOM — a hand-written fixture would encode what I *think* X emits and pass
 * against nothing.
 *
 * The property under test is not "does it find the numbers" but "does it distinguish a
 * counter that is absent from one that reads zero". A selector that stops matching must
 * produce nulls, because the callers store what they are given and a stored 0 is
 * indistinguishable from an article nobody engaged with — which is how a broken scrape
 * becomes a silently collapsed Trending board.
 */

const HTML = readFileSync(
  fileURLToPath(new URL('../fixtures/x-article-engagement-2101779116056088732.html', import.meta.url)),
  'utf8',
);

describe('parseCount', () => {
  it('reads the abbreviated forms X renders', () => {
    expect(parseCount('48K')).toBe(48_000);
    expect(parseCount('8.3M')).toBe(8_300_000);
    expect(parseCount('2K')).toBe(2_000);
    expect(parseCount('4.7K')).toBe(4_700);
    expect(parseCount('1.2B')).toBe(1_200_000_000);
  });

  it('reads a plain number, with or without separators', () => {
    expect(parseCount('1234')).toBe(1_234);
    expect(parseCount('1,234')).toBe(1_234);
    expect(parseCount('0')).toBe(0);
  });

  it('is case-insensitive about the suffix', () => {
    // X's own output shifts case between locales, and there is no reading where `k` means
    // something other than thousands.
    expect(parseCount('48k')).toBe(48_000);
    expect(parseCount('8.3m')).toBe(8_300_000);
  });

  it('returns null — not 0 — for anything it cannot read', () => {
    // The distinction the whole feature rests on. `0` means X rendered a zero; `null` means
    // there was nothing to read, and only the caller can decide what to store.
    expect(parseCount('')).toBeNull();
    expect(parseCount('abc')).toBeNull();
    expect(parseCount('K')).toBeNull();
    expect(parseCount('4.7.1K')).toBeNull();
    expect(parseCount('1.2X')).toBeNull();
  });
});

describe('extractEngagement against a real capture', () => {
  const metrics = extractEngagement(HTML);

  it('reads every counter the page actually renders', () => {
    // Read off the fixture by hand before the extractor existed: like 48K, retweet 4.7K,
    // reply 2K, view count 8.3M. Pinning the numbers means a change in X's markup fails
    // here rather than silently shifting the ranking.
    expect(metrics.likes).toBe(48_000);
    expect(metrics.reposts).toBe(4_700);
    expect(metrics.replies).toBe(2_000);
    expect(metrics.views).toBe(8_300_000);
  });

  it('leaves the counters X does not render as null', () => {
    // Asserted rather than omitted, because 0 would be a claim: `bookmarks` is a real
    // button with no counter beside it on an Article, and `quotes` X exposes nowhere.
    expect(metrics.bookmarks).toBeNull();
    expect(metrics.quotes).toBeNull();
  });

  it('returns all nulls for a page with no engagement markup', () => {
    // The failure mode a real markup change would produce. Every field must go null
    // together; one field silently defaulting to 0 is the shape of bug this guards.
    const bare = extractEngagement('<html><body><p>nothing here</p></body></html>');
    expect(bare).toEqual({
      likes: null,
      reposts: null,
      replies: null,
      quotes: null,
      bookmarks: null,
      views: null,
    });
  });

  it('does not pick up a counter from the neighbouring block', () => {
    // The blocks sit in one row, so a window that reads too far would attribute the next
    // button's number to this one.
    //
    // The first version of this test put two small blocks side by side and passed even with
    // the window widened to 9000 characters — because a 9000-character window starting at the
    // first attribute covers the second block anyway, and the assertion only checked that
    // each value was *present*, which reading too far cannot break. It was testing nothing.
    //
    // So the neighbour here is padded, and the assertion is on a key whose own block has no
    // counter at all: `bookmarks` must be null even though a number sits in a block after it.
    const padding = 'x'.repeat(2_000);
    const synthetic =
      '<div data-engagement-action="bookmark"><span class="tabular-nums">no count here</span>' +
      padding +
      '</div><div data-engagement-action="generic"><span class="x-animated-count-visual">8.3M</span></div>';
    const m = extractEngagement(synthetic);
    expect(m.bookmarks, 'a bounded window must not read the next block').toBeNull();
    expect(m.views).toBe(8_300_000);
  });

  it('falls back to the tabular-nums span when the animated one is gone', () => {
    // Two hooks for the count, because `x-animated-count-visual` is the animation and is the
    // likelier of the two to be restructured.
    const onlyTabular = '<div data-engagement-action="like"><span class="tabular-nums text-subtext2 ps-1">1.5K</span></div>';
    expect(extractEngagement(onlyTabular).likes).toBe(1_500);
  });
});

describe('the metrics pipeline stores absence and zero differently', () => {
  const selectors = readFileSync(resolve('src/jobs/x-selectors.ts'), 'utf8');
  const crawl = readFileSync(resolve('src/services/crawl.ts'), 'utf8');
  const refresh = readFileSync(resolve('src/services/ranking-refresh.ts'), 'utf8');
  const worker = readFileSync(resolve('src/worker.ts'), 'utf8');
  const wrangler = readFileSync(resolve('wrangler.jsonc'), 'utf8');

  /** Source with its comments stripped, so an assertion is about code and not about prose. */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('types every counter as nullable', () => {
    // The type is the enforcement: a `number` here would force the extractor to invent a
    // value for a missing counter, and 0 is the only one it could invent.
    expect(selectors).toMatch(/export interface EngagementMetrics \{[\s\S]*?\}/);
    const iface = /export interface EngagementMetrics \{([\s\S]*?)\n\}/.exec(selectors)?.[1] ?? '';
    expect(iface, 'cannot locate EngagementMetrics').not.toBe('');
    const fields = iface.match(/^\s+\w+:\s*[^;]+;/gm) ?? [];
    expect(fields).toHaveLength(6);
    for (const field of fields) {
      expect(field, `${field.trim()} must allow null`).toContain('number | null');
    }
  });

  it('writes a snapshot on both crawl outcomes', () => {
    // Two paths return successfully: `archived` (a new version) and `unchanged` (the body
    // matched the stored hash). Metrics are only interesting on the second one — an article
    // being read right now has the same prose it had yesterday and a very different like
    // count — so writing only on the first would freeze the score of exactly the articles
    // that are still moving.
    //
    // Caught by a real re-crawl returning `unchanged` with no metrics row written, which is
    // why this counts the call sites rather than checking for one.
    const calls = code(crawl).match(/recordMetrics\(env, articleId, metadata\.metrics, capturedAt\)/g) ?? [];
    expect(calls, 'both the archived and the unchanged path must snapshot').toHaveLength(2);
    expect(crawl).toMatch(/INSERT INTO article_metrics/);
  });

  it('reports the captured count on both outcomes', () => {
    // The count is the only signal a selector stopped matching, so neither path may skip it.
    const logs = code(crawl).match(/metrics_fields: metricsFields/g) ?? [];
    expect(logs).toHaveLength(2);
  });

  it('records which counters were missing, so a broken selector is visible', () => {
    // Nothing else reports it: a null counter ranks last either way, so the only symptom is
    // a trending board that quietly equals latest.
    expect(crawl).toMatch(/metrics_fields: metricsFields/);
    expect(crawl).toMatch(/return values\.filter\(\(v\) => v !== null\)\.length/);
  });

  it('reads the newest snapshot per article when scoring', () => {
    // `article_metrics` is a time series; averaging or summing the history would rank an
    // article by how many times it had been re-crawled.
    expect(refresh).toMatch(/MAX\(m2\.captured_at\)/);
  });

  it('scores exactly the articles the board will show', () => {
    // Same predicate as `/trending` itself. An unpublished article in the candidate set
    // would shift the min-max normalization of the ones that are shown.
    expect(refresh).toMatch(/a\.status = 'published' AND a\.display_mode != 'takedown'/);
  });

  it('applies the scores in one batch', () => {
    // D1 rejects BEGIN/COMMIT, so batch() is the only atomicity available. A partly-applied
    // refresh would leave the board ordering by two different candidate sets.
    expect(refresh).toMatch(/await env\.DB\.batch\(statements\)/);
  });

  it('is registered on a cron trigger and in the worker', () => {
    expect(wrangler).toMatch(/"triggers"[\s\S]*?"crons"[\s\S]*?"\*\/30 \* \* \* \*"/);
    expect(code(worker)).toMatch(/refreshRanking\(env\)/);
    // `waitUntil`, not a bare await: the runtime may end the invocation once the handler's
    // promise settles, and the refresh must not be cut off mid-write.
    expect(code(worker)).toMatch(/ctx\.waitUntil\(/);
  });

  it('can be run by hand, because the cron is otherwise invisible', () => {
    const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
    expect(adminUi).toMatch(/adminUi\.post\('\/ranking\/refresh'/);
    // The same function the cron calls — one implementation of what a score means.
    expect(adminUi).toMatch(/await refreshRanking\(c\.env\)/);
  });
});
