import { describe, expect, it } from 'vitest';
import { CRAWL_TERMINAL_STATUS } from '../../src/services/crawl';
import { TRANSITIONS } from '../../src/services/publish';
import type { ArticleStatus } from '../../src/jobs/types';

/**
 * SPEC §6 state machine.
 *
 * These tests exist because of a real bug: the crawl used to terminate at
 * `fetched`, but `fetched` cannot reach `published` — only `review` can. With
 * parsing (Phase 3) and AI enrichment (Phase 4) not implemented, the crawl's
 * terminal state was therefore a dead end and the editor's Publish button could
 * never succeed. The invariant is now pinned here.
 */

const ALL_STATUSES: ArticleStatus[] = [
  'pending',
  'fetching',
  'fetched',
  'parsing',
  'review',
  'published',
  'rejected',
  'archived',
  'takedown',
  'failed',
];

describe('TRANSITIONS (SPEC §6)', () => {
  it('covers every status exactly once', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('never lists a transition to an unknown status', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATUSES, `${from} → ${to}`).toContain(to);
      }
    }
  });

  it('lists no self-transitions, because idempotent re-entry is handled earlier', () => {
    // `assertTransition` returns early on from === to, so a self-edge would be
    // dead weight and would hide a genuine machine change.
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(targets, from).not.toContain(from);
    }
  });

  it("publishes only from 'review', the state §16.3 puts publishing in", () => {
    const sources = ALL_STATUSES.filter((s) => TRANSITIONS[s].includes('published'));
    expect(sources).toEqual(['review']);
  });

  it("lets the crawl's terminal status reach published", () => {
    // The exact invariant that broke: without it, nothing could ever be published.
    expect(TRANSITIONS[CRAWL_TERMINAL_STATUS]).toContain('published');
  });

  it('can reach published from import along the path an operator walks', () => {
    const path: ArticleStatus[] = ['pending', 'fetching', 'fetched', CRAWL_TERMINAL_STATUS, 'published'];

    for (let i = 1; i < path.length; i += 1) {
      expect(TRANSITIONS[path[i - 1]!], `${path[i - 1]} → ${path[i]}`).toContain(path[i]!);
    }
  });

  it('can take down an article from any state except one already taken down', () => {
    // SPEC §37 — governance must never be blocked by workflow state. Takedown
    // from `takedown` is a no-op, handled before the machine.
    const blocked = ALL_STATUSES.filter((s) => !TRANSITIONS[s].includes('takedown'));
    expect(blocked).toEqual(['takedown']);
  });

  it('lets any captured article come back to review', () => {
    // `fetching` is deliberately excluded: an article mid-crawl has no capture to
    // review yet. `failed` is excluded because it re-enters through `pending`,
    // which is the honest way back — the editor asked for a re-crawl, not a review.
    const exceptions: ArticleStatus[] = ['review', 'fetching', 'failed'];
    const blocked = ALL_STATUSES.filter((s) => !exceptions.includes(s) && !TRANSITIONS[s].includes('review'));
    expect(blocked).toEqual([]);
  });

  it('leaves no state without a way out', () => {
    for (const status of ALL_STATUSES) {
      expect(TRANSITIONS[status].length, status).toBeGreaterThan(0);
    }
  });
});
