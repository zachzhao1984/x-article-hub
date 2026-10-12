import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §6 — a parse promotes a stranded article into the review queue.
 *
 * ## The failure this pins
 *
 * The crawl owns an article's status and the parse does not, which is right: a parse is a
 * content operation and an editor's decision should not be overwritten by a machine step. But
 * a crawl can fail *after* it has written its capture — a `PAGE_BLOCKED` on a retry, a
 * partial-then-complete fetch — and the article is then left at `failed` while a complete
 * document sits in R2. Nothing else moves it, so the article is invisible to the editor and
 * unreachable by every public query: the import reads as broken for content that is already
 * archived. Measured on production: 13 of 100 articles were in exactly this state, one of
 * them with 87 blocks and 3,427 characters of intact prose.
 *
 * ## Why the guard is the whole point
 *
 * Only `failed` may be promoted. Promoting anything else would let a machine step undo an
 * editorial decision — the same hazard `nextStatusAfterCrawl` guards against for publishing.
 * `pending` and `fetching` must not be promoted either, because a crawl is still in flight and
 * racing it would put an article in review before its capture settled.
 */

const parseJob = readFileSync(resolve('src/jobs/parse.ts'), 'utf8');

/** Source with comments stripped, so an assertion is about code and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the parse job promotes a stranded article', () => {
  it('sets failed to review, and only failed', () => {
    const body = code(parseJob);
    // The promotion exists at all — without it the 13 stranded articles stay invisible.
    expect(body).toMatch(/setArticleStatus\(env\.DB, message\.articleId, 'review'\)/);
    // And it is gated on the status being `failed`. A guard written as an allow-list of
    // "anything not published" would also catch `pending`/`fetching` and race a live crawl.
    expect(body).toMatch(/article\.status === 'failed'/);
    expect(body).not.toMatch(/'published'.*setArticleStatus|setArticleStatus.*'published'/);
  });

  it('requires a raw capture, so nothing with an empty archive is promoted', () => {
    // A document with no capture would put an article in front of an editor that has nothing
    // to read. The parse succeeding implies a capture, but the guard is what makes that a
    // property of the code rather than of an assumption.
    const body = code(parseJob);
    expect(body).toMatch(/article\.raw_r2_key/);
  });

  it('runs after the parse succeeds, not before', () => {
    // Promoting first would put an article in review whose document was never written.
    const body = code(parseJob);
    const success = body.indexOf("updateJobStatus(env.DB, message.jobId, 'success')");
    const promote = body.indexOf("setArticleStatus(env.DB, message.articleId, 'review')");
    expect(success).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(success);
  });

  it('imports what it calls', () => {
    // The failure mode this codebase has already been bitten by: a helper used and not
    // imported compiles, passes every test, and throws on the Worker.
    expect(parseJob).toMatch(/import \{[^}]*setArticleStatus[^}]*\} from '\.\.\/db\/articles'/);
  });
});
