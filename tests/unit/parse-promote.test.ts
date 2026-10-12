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
 * archived. Measured on production: 13 of 100 articles were in exactly this state, one of them
 * with 87 blocks and 3,427 characters of intact prose.
 *
 * ## Why it lives in the service
 *
 * The first attempt put the promotion in the queue handler `handleParse`, and re-parsing the
 * stranded articles through the admin's own endpoint did not fix them — that endpoint calls
 * `parseArticle` directly and never goes through the handler. The promotion therefore has to
 * be in the service, on both success paths, so every caller gets it; this file asserts that,
 * because putting it in one caller is the mistake that was actually made.
 */

const parseService = readFileSync(resolve('src/services/parse.ts'), 'utf8');
const parseJob = readFileSync(resolve('src/jobs/parse.ts'), 'utf8');

/** Source with comments stripped, so an assertion is about code and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('promoteIfStranded', () => {
  it('exists in the service, so every parse caller gets it', () => {
    // The admin endpoint calls `parseArticle`; the queue handler calls it. Only putting this
    // in the handler is the specific mistake that was made and that this asserts against.
    expect(code(parseService)).toMatch(/export async function promoteIfStranded\(/);
  });

  it('sets failed to review, and only failed', () => {
    const body = code(parseService);
    expect(body).toMatch(/setArticleStatus\(env\.DB, article\.id, 'review'\)/);
    // A guard written as "anything not published" would also catch `pending`/`fetching` and
    // race a live crawl.
    expect(body).toMatch(/article\.status !== 'failed'/);
  });

  it('requires a raw capture, so nothing with an empty archive is promoted', () => {
    expect(code(parseService)).toMatch(/!article\.raw_r2_key/);
  });

  it('is called on both success paths, not only the full parse', () => {
    // The `unchanged` early-return is the path a re-parse of an already-parsed article takes —
    // which is exactly how a stranded article gets fixed — so a promotion only on the full
    // parse would miss the case that motivated it.
    const body = code(parseService);
    const calls = body.match(/promoteIfStranded\(env, article\)/g) ?? [];
    expect(calls.length, 'promotion is not called on both paths').toBe(2);
  });

  it('runs after the document is written, not before', () => {
    const body = code(parseService);
    const write = body.indexOf('writeArticleDocument');
    const promote = body.lastIndexOf('promoteIfStranded(env, article)');
    expect(write).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(write);
  });

  it('is not duplicated in the queue handler', () => {
    // Two copies would drift; the handler now gets it through the service call it already makes.
    expect(code(parseJob)).not.toMatch(/promoteIfStranded|setArticleStatus/);
  });

  it('imports what it calls', () => {
    // The failure mode this codebase has already been bitten by: a helper used and not
    // imported compiles, passes every test, and throws on the Worker.
    expect(parseService).toMatch(/import \{[^}]*setArticleStatus[^}]*\} from '\.\.\/db\/articles'/);
  });
});
