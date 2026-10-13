/**
 * SPEC §13 — the AI classifier, which is the half of the "editor assistant" that got
 * wired up.
 *
 * Two halves. `extractSlug` is pure and is tested as logic, because parsing whatever a
 * model decides to say is the part that actually goes wrong. The rest needs D1 and
 * Workers AI, which this suite deliberately does not stub (see vitest.config.ts), so
 * those are asserted against the source — each assertion pinning a decision that would
 * otherwise be invisible in a diff: which column gets written, what stops the cron from
 * retrying forever, and that the taxonomy comes from the table rather than a constant.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSIFY_BODY_CHARS, CLASSIFY_MODEL, CLASSIFY_RECLAIM_MS, extractSlug } from '../../src/services/classify';

const classify = readFileSync(resolve('src/services/classify.ts'), 'utf8');
const aiJob = readFileSync(resolve('src/jobs/ai.ts'), 'utf8');
const dispatch = readFileSync(resolve('src/jobs/dispatch.ts'), 'utf8');
const parseJob = readFileSync(resolve('src/jobs/parse.ts'), 'utf8');
const worker = readFileSync(resolve('src/worker.ts'), 'utf8');

/** Source with comments stripped, so an assertion is about code and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The eight slugs the taxonomy actually has. */
const SLUGS = new Set([
  'ai', 'technology', 'business', 'science', 'ideas', 'gaming', 'culture', 'lifestyle',
]);

describe('extractSlug', () => {
  it('takes a bare slug', () => {
    expect(extractSlug('gaming', SLUGS)).toBe('gaming');
  });

  it('takes a slug with the chrome models add anyway', () => {
    // Told to reply with one slug and nothing else; models still bracket, punctuate and
    // preface. Every one of these is a real reply shape, not an invented one.
    expect(extractSlug('gaming.', SLUGS)).toBe('gaming');
    expect(extractSlug('`culture`', SLUGS)).toBe('culture');
    expect(extractSlug('Category: lifestyle', SLUGS)).toBe('lifestyle');
    expect(extractSlug('**business**', SLUGS)).toBe('business');
  });

  it('is case-insensitive, since slugs are stored lowercase and models are not', () => {
    expect(extractSlug('LIFESTYLE', SLUGS)).toBe('lifestyle');
    expect(extractSlug('Technology', SLUGS)).toBe('technology');
  });

  it('prefers the longest slug, so `ai` cannot win by sitting inside another word', () => {
    // The real hazard: `ai` is two letters and appears inside hundreds of words. Longest
    // first means a reply mentioning business and ai resolves to business.
    expect(extractSlug('business', SLUGS)).toBe('business');
    expect(extractSlug('this is about business, not ai', SLUGS)).toBe('business');
  });

  it('only matches a slug as a whole word', () => {
    expect(extractSlug('aid', SLUGS)).toBeNull();
    expect(extractSlug('retail', SLUGS)).toBeNull();
    expect(extractSlug('contain', SLUGS)).toBeNull();
    // …but a real standalone `ai` still resolves.
    expect(extractSlug('ai', SLUGS)).toBe('ai');
    expect(extractSlug('this article is ai', SLUGS)).toBe('ai');
  });

  it('returns null rather than guessing when the reply has no slug', () => {
    // The caller leaves the article uncategorised on null. Guessing here would write a
    // category the model never chose, and `category_id` has no foreign key, so a wrong
    // value is invisible rather than rejected.
    expect(extractSlug('unsure', SLUGS)).toBeNull();
    expect(extractSlug('人工智能', SLUGS)).toBeNull();
    expect(extractSlug('', SLUGS)).toBeNull();
  });

  it('reads the first slug when a reply lists several', () => {
    expect(extractSlug('gaming\nculture', SLUGS)).toBe('gaming');
  });
});

describe('which column is written', () => {
  it('writes category_id and only ever guards on editor_category_id being null', () => {
    const body = code(classify);
    expect(body).toMatch(/UPDATE articles SET category_id =/);
    // The precedence the whole design rests on: a human pick wins, so the write is
    // conditional and never touches the editor column.
    expect(body).toMatch(/WHERE id = \?1 AND editor_category_id IS NULL/);
    expect(body).not.toMatch(/UPDATE articles SET editor_category_id/);
  });

  it('skips the model call entirely when a human has already chosen', () => {
    // Not just a guard on the write — the point is to not spend quota arguing with an
    // editor.
    expect(code(classify)).toMatch(/if \(article\.editor_category_id\)/);
  });

  it('re-checks the override at write time, not only at read time', () => {
    // An editor can pick a category in the seconds between the model call and the write.
    expect(code(classify).match(/editor_category_id IS NULL/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('what the model is given', () => {
  it('reads plain text, never the HTML or the block structure', () => {
    // SPEC §13.4. `fts_content` is the plain-text column the search index is built from.
    const body = code(classify);
    expect(body).toMatch(/substr\(COALESCE\(fts_content, ''\), 1, \?2\) AS body/);
    expect(body).not.toMatch(/blocks/);
  });

  it('caps the input, and the cap is a bound parameter rather than a slice in SQL', () => {
    expect(CLASSIFY_BODY_CHARS).toBeGreaterThan(0);
    expect(CLASSIFY_BODY_CHARS).toBeLessThanOrEqual(4000);
    expect(code(classify)).toMatch(/\.bind\(articleId, CLASSIFY_BODY_CHARS\)/);
  });

  it('builds the category list from the table, so a migration is enough to extend it', () => {
    const body = code(classify);
    expect(body).toMatch(/await listCategories\(env\.DB\)/);
    // A hardcoded slug list is how the taxonomy silently drifts from the database — and
    // this file would then need editing every time a category is added.
    expect(body).not.toMatch(/'technology'.*'business'/s);
  });

  it('uses one model id, held in an exported constant', () => {
    // SPEC §32: the id is a value, not a permanent standard.
    expect(classify).toMatch(new RegExp(`export const CLASSIFY_MODEL = '${CLASSIFY_MODEL.replace(/[/]/g, '\\/')}'`));
    const occurrences = classify.split(CLASSIFY_MODEL).length - 1;
    expect(occurrences, 'the model id should appear once, in its declaration').toBe(1);
  });
});

describe('wiring', () => {
  it('registers a real consumer for `ai`, which was the declared type with none', () => {
    const body = code(dispatch);
    expect(body).toMatch(/ai: handleAi/);
    expect(body).not.toMatch(/ai: notImplemented/);
    // `metrics` and `reindex` are still deferred, and should stay visibly so.
    expect(body).toMatch(/metrics: notImplemented\('metrics'\)/);
    expect(body).toMatch(/reindex: notImplemented\('reindex'\)/);
  });

  it('is scheduled by the parse job, so every parsed article is classified', () => {
    // The ordering argument: there is no path that produces a document without also
    // asking for a category. Calling it from the import route instead would leave the
    // admin's direct re-parse endpoint unclassified.
    expect(code(parseJob)).toMatch(/enqueueProcessJob\(env, message\.articleId, 'ai'\)/);
  });

  it('shares the media job\'s enqueue helper, so idempotency cannot drift', () => {
    const body = code(parseJob);
    expect(body.match(/enqueueProcessJob\(env, message\.articleId, /g)!.length).toBe(2);
    // `INSERT OR IGNORE` against the partial unique index is what makes a redelivered
    // parse unable to stack a second run.
    expect(body).toMatch(/INSERT OR IGNORE INTO crawl_jobs/);
  });

  it('runs from the cron as a backstop', () => {
    expect(code(worker)).toMatch(/classifyUncategorized\(env, \d+\)/);
  });
});

describe('the cron backstop cannot retry forever, but can take back abandoned work', () => {
  it('excludes an article whose classification already finished', () => {
    // The failure mode this prevents: an article the model refuses to classify would
    // otherwise cost one model call every thirty minutes until the daily free-tier
    // allocation was gone — which would also stop covers being generated, since they
    // share it.
    const body = code(classify);
    expect(body).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM crawl_jobs j\s*WHERE j\.article_id = a\.id AND j\.job_type = 'ai'/);
    expect(body).toMatch(/j\.status IN \('success', 'skipped'\)/);
  });

  it('reclaims a row the queue abandoned, so a quota failure is not permanent', () => {
    // `handleBatch` retries by re-throwing and never writes to the job row, so a message
    // the queue gives up on leaves it `queued` for good. Without this clause that
    // zombie row would exclude the article forever — and the one condition that most
    // needs a retry, the daily allocation running out, is exactly what would strand it.
    const body = code(classify);
    expect(body).toMatch(/j\.status IN \('pending', 'queued', 'running', 'retrying'\)/);
    expect(body).toMatch(/j\.updated_at > \?2/);
  });

  it('holds the window long enough that the cron cannot race a live consumer', () => {
    // The queue's ladder is five deliveries with backoff, well under an hour. Two hours
    // is what makes "still in flight" and "abandoned" distinguishable at all.
    expect(CLASSIFY_RECLAIM_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it('claims a job row before classifying, so the queue path and the cron cannot both run', () => {
    const body = code(classify);
    expect(body).toMatch(/INSERT OR IGNORE INTO crawl_jobs[\s\S]*'ai', 'queued'/);
    // A zero-row insert means something else owns it, and only then is a reclaim
    // attempted — against a row that is neither finished nor recent.
    expect(body).toMatch(/if \(\(inserted\.meta\.changes \?\? 0\) > 0\) return jobId/);
    expect(body).toMatch(/status NOT IN \('success', 'skipped'\)/);
    expect(body).toMatch(/updated_at <= \?2/);
  });

  it('only ever selects published articles with no category at all', () => {
    const body = code(classify);
    expect(body).toMatch(/a\.status = 'published'/);
    expect(body).toMatch(/a\.editor_category_id IS NULL/);
    expect(body).toMatch(/a\.category_id IS NULL/);
  });
});

describe('failures are terminal, not retried', () => {
  it('marks a no-match job skipped or failed rather than letting the queue retry', () => {
    // The queue retries when a handler throws. A model that declined to pick a slug once
    // will decline again, and each attempt costs quota — so the handler records the
    // outcome and returns.
    const body = code(aiJob);
    expect(body).toMatch(/const status = outcome\.errorCode === 'NOT_FOUND' \? 'skipped' : 'failed'/);
    expect(body).not.toMatch(/throw/);
  });

  it('treats an already-completed job as done, so a redelivery is free', () => {
    expect(code(aiJob)).toMatch(/job\.status === 'success' \|\| job\.status === 'skipped'/);
  });
});
