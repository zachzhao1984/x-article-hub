/**
 * SPEC §13 — the AI "editor assistant". This is the half of it that got wired:
 * categorisation only. Summary, topics, tags and quality scoring are still not
 * implemented, and deliberately so — they are four more model calls per article
 * against a free-tier daily quota, and none of them has a reader on the site yet.
 *
 * Why categorisation was worth the call: without it every imported article sat in
 * "no category", which is exactly the state the header filter and `/category/<slug>`
 * pages exist to escape. `articles.category_id` is the machine column, and the app
 * reads `COALESCE(editor_category_id, category_id)` — so a human pick made later in
 * the admin always wins over whatever is written here. That precedence is the whole
 * reason this writes to `category_id` and never to `editor_category_id`.
 */

import { log } from '../lib/logger';
import { listCategories } from '../db/categories';
import { updateJobStatus } from '../db/jobs';
import { newId } from '../lib/ids';

/**
 * SPEC §32 — the model id is a value, not a permanent standard. One constant so a
 * model that disappears is a one-line fix rather than a hunt.
 *
 * Qwen rather than a Llama: roughly half this archive is Chinese or Japanese, and a
 * classifier that cannot read the article has to guess from the title alone. It is a
 * 30B MoE with ~3B active, so the per-call cost stays near a small dense model.
 */
export const CLASSIFY_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

/**
 * SPEC §13.4 — cap what the model sees. The input is someone else's writing, and the
 * first ~1500 characters carry the topic: this corpus opens with its thesis, and the
 * 98 articles classified by hand used less than this to decide every one of them.
 *
 * A character cap rather than a token cap, because CJK runs roughly a character to a
 * token while English runs four characters to one — a token budget would hand the two
 * languages different amounts of text for no benefit.
 */
export const CLASSIFY_BODY_CHARS = 1500;

/**
 * How long an open `ai` job may sit untouched before the cron takes it back.
 *
 * This exists because of one specific failure: `handleBatch` retries by re-throwing,
 * and nothing writes to the job row when it does, so a message the queue eventually
 * gives up on leaves that row `queued` for good. That is precisely what happens when a
 * call fails because the daily free allocation ran out — a transient condition — and
 * without a reclaim window the article would then be excluded by the cron's own guard
 * and would never get a category at all.
 *
 * Two hours, comfortably longer than the queue's retry ladder (five deliveries with
 * backoff, well under an hour) so the cron cannot take an article out from under a
 * consumer that is still working on it.
 */
export const CLASSIFY_RECLAIM_MS = 2 * 60 * 60 * 1000;

export interface ClassifyOutcome {
  ok: boolean;
  /** `classified` wrote a category, `editor_override` skipped the call, `no_match` gave up. */
  result: 'classified' | 'editor_override' | 'no_match' | 'not_found' | 'no_categories';
  categorySlug?: string;
  errorCode?: string;
  errorMessage?: string;
  /** What the model actually said, for the log. Empty when the model was never called. */
  raw?: string;
}

interface ArticleTextRow {
  id: string;
  title: string | null;
  body: string | null;
  editor_category_id: string | null;
}

/**
 * Decide an article's category and write it.
 *
 * `editor_category_id` is read first and treated as final: a human has already chosen,
 * so spending a model call to disagree would be both wasteful and rude. The write is
 * guarded by the same condition, so a pick made between the read and the write still wins.
 */
export async function classifyArticle(env: Env, articleId: string): Promise<ClassifyOutcome> {
  const article = await env.DB.prepare(
    `SELECT id, title, substr(COALESCE(fts_content, ''), 1, ?2) AS body, editor_category_id
       FROM articles WHERE id = ?1`,
  )
    .bind(articleId, CLASSIFY_BODY_CHARS)
    .first<ArticleTextRow>();

  if (!article) return { ok: false, result: 'not_found', errorCode: 'NOT_FOUND', errorMessage: 'Article row no longer exists' };

  if (article.editor_category_id) {
    return { ok: true, result: 'editor_override', categorySlug: undefined };
  }

  const categories = await listCategories(env.DB);
  if (categories.length === 0) {
    return { ok: false, result: 'no_categories', errorCode: 'NO_CATEGORIES', errorMessage: 'The categories table is empty' };
  }

  const title = (article.title ?? '').trim();
  const body = (article.body ?? '').trim();
  if (!title && !body) {
    return { ok: false, result: 'no_match', errorCode: 'NO_TEXT', errorMessage: 'The article has neither a title nor a body' };
  }

  const known = new Set(categories.map((c) => c.slug));
  const prompt = buildPrompt(categories, title, body);

  // SPEC §13.2 — the model cannot be trusted to follow an instruction perfectly, so the
  // reply is parsed and then validated against the table rather than written through.
  // `category_id` has no foreign key, which makes a bogus value *invisible*: the article
  // simply stops showing up under any category. Validating here is what keeps that from
  // happening silently.
  const response = await env.AI.run(CLASSIFY_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You classify articles for a curated reading site. ' +
          'Reply with EXACTLY ONE category slug from the list given by the user, ' +
          'and nothing else — no sentence, no explanation, no numbering, no punctuation.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 512,
    temperature: 0,
  });

  const raw = (response as { response?: string }).response ?? '';
  const slug = extractSlug(raw, known);

  if (!slug) {
    // Not retried on purpose. A model that declined to pick a slug once will decline
    // again, and each attempt costs quota — the queue's retry ladder is for transport
    // failures, not for a stable refusal.
    return { ok: false, result: 'no_match', errorCode: 'NO_MATCH', errorMessage: `No known category in the reply: ${raw.slice(0, 80)}`, raw };
  }

  // Re-check the override right before writing, then write only the machine column.
  const updated = await env.DB.prepare(
    `UPDATE articles SET category_id = (SELECT id FROM categories WHERE slug = ?2)
      WHERE id = ?1 AND editor_category_id IS NULL`,
  )
    .bind(articleId, slug)
    .run();

  if ((updated.meta.changes ?? 0) === 0) {
    log.info('ai_skipped', { article_id: articleId, reason: 'editor_override_arrived_first' });
    return { ok: true, result: 'editor_override' };
  }

  return { ok: true, result: 'classified', categorySlug: slug, raw };
}

/**
 * The category list goes in the prompt from the table rather than from a constant, so
 * adding a category with a migration is enough — the classifier picks it up on its next
 * call with no code change. A hardcoded list is how the taxonomy silently drifts.
 */
function buildPrompt(
  categories: Array<{ slug: string; name: string; description: string | null }>,
  title: string,
  body: string,
): string {
  const list = categories.map((c) => `- ${c.slug}: ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n');
  return [
    'Categories (reply with one of these slugs):',
    list,
    '',
    'The article may be written in any language. Judge it by its subject, not its language.',
    'A practical how-to about health, sleep, food or personal money is "lifestyle".',
    'Relationships, media, and social or interpersonal psychology are "culture".',
    'Abstract essays about thinking or how to live are "ideas".',
    '',
    `Title: ${title}`,
    '',
    `Article text:`,
    body,
  ].join('\n');
}

/**
 * Pull a slug out of whatever the model said.
 *
 * Two passes, because models add chrome even when told not to. A line that *is* the
 * slug is the common case and is checked first; a whole-word search is the fallback for
 * `"gaming."` or `Category: gaming`. Longer slugs are matched first so `ai` cannot win
 * by appearing inside a longer word.
 */
export function extractSlug(raw: string, known: Set<string>): string | null {
  const cleaned = raw.replace(/[`*_]/g, '').trim();

  for (const line of cleaned.split(/\r?\n/)) {
    const candidate = line.replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/gi, '').trim().toLowerCase();
    if (known.has(candidate)) return candidate;
  }

  for (const slug of [...known].sort((a, b) => b.length - a.length)) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(cleaned)) return slug;
  }

  return null;
}

/**
 * The cron's half: bring any published article that still has no category up to one.
 *
 * This is the backstop, not the main path — `handleParse` schedules classification for
 * every article it parses. It exists because the archive predates the classifier and
 * because a queue message can be lost: without it, "no category" would be a state an
 * article could sit in forever.
 *
 * The `crawl_jobs` row is what stops this from retrying forever. `claimAiJob` inserts
 * one per article, and an article whose classification already failed keeps a `failed`
 * row, so it is excluded by the query rather than charged for again. That matters
 * against a free-tier quota: an article the model refuses to classify would otherwise
 * cost one call every thirty minutes until the daily allocation ran out, which is the
 * failure mode that would take the cover generator down with it.
 */
export async function classifyUncategorized(
  env: Env,
  limit: number,
): Promise<{ attempted: number; classified: number; failed: number }> {
  const staleBefore = Date.now() - CLASSIFY_RECLAIM_MS;
  const missing = await env.DB.prepare(
    `SELECT a.id
       FROM articles a
      WHERE a.status = 'published'
        AND a.editor_category_id IS NULL
        AND a.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM crawl_jobs j
           WHERE j.article_id = a.id AND j.job_type = 'ai'
             AND (j.status IN ('success', 'skipped')
                  OR (j.status IN ('pending', 'queued', 'running', 'retrying')
                      AND j.updated_at > ?2)))
      ORDER BY a.imported_at DESC
      LIMIT ?1`,
  )
    .bind(limit, staleBefore)
    .all<{ id: string }>();

  let classified = 0;
  let failed = 0;

  for (const row of missing.results) {
    const jobId = await claimAiJob(env.DB, row.id, staleBefore);
    if (!jobId) continue;

    const outcome = await classifyArticle(env, row.id);

    await updateJobStatus(env.DB, jobId, outcome.ok ? 'success' : 'failed', outcome.ok
      ? undefined
      : { code: outcome.errorCode ?? 'CLASSIFY_FAILED', message: outcome.errorMessage ?? '' });

    if (outcome.ok && outcome.result === 'classified') {
      classified += 1;
      log.info('ai_success', { article_id: row.id, job_id: jobId, model: CLASSIFY_MODEL, category_slug: outcome.categorySlug ?? null });
    } else if (outcome.ok) {
      log.info('ai_skipped', { article_id: row.id, job_id: jobId, reason: outcome.result });
    } else {
      failed += 1;
      log.error('ai_failed', { article_id: row.id, job_id: jobId, error_code: outcome.errorCode, error_message: outcome.errorMessage });
    }
  }

  return { attempted: missing.results.length, classified, failed };
}

/**
 * Take ownership of classifying one article, or report that something else already has.
 *
 * Two steps, because there are two things to guard against. The insert is against the
 * same partial unique index the queue path uses, so the cron and a parsed article's own
 * job can never both start. When a row already exists it is taken back only if it is
 * stale: a `success` or `skipped` row is finished work and is left alone, and a row
 * updated recently is a consumer still in flight. A row that has been sitting `queued`
 * since the queue gave up is exactly the case the reclaim window exists for.
 *
 * The update targets whichever `ai` row the article has rather than the id just bound,
 * because when the insert was ignored that bound id was never written — the row to
 * reset is the one that stopped it.
 */
async function claimAiJob(db: D1Database, articleId: string, staleBefore: number): Promise<string | null> {
  const jobId = newId('job');
  const now = Date.now();

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO crawl_jobs (id, article_id, job_type, status, attempt_count, deliveries, created_at, updated_at)
       VALUES (?1, ?2, 'ai', 'queued', 0, 0, ?3, ?3)`,
    )
    .bind(jobId, articleId, now)
    .run();

  if ((inserted.meta.changes ?? 0) > 0) return jobId;

  const reclaimed = await db
    .prepare(
      `UPDATE crawl_jobs
          SET status = 'queued', updated_at = ?3, error_code = NULL, error_message = NULL
        WHERE article_id = ?1 AND job_type = 'ai'
          AND status NOT IN ('success', 'skipped')
          AND updated_at <= ?2`,
    )
    .bind(articleId, staleBefore, now)
    .run();

  if ((reclaimed.meta.changes ?? 0) === 0) return null;

  const existing = await db
    .prepare(`SELECT id FROM crawl_jobs WHERE article_id = ?1 AND job_type = 'ai' LIMIT 1`)
    .bind(articleId)
    .first<{ id: string }>();

  return existing?.id ?? null;
}
