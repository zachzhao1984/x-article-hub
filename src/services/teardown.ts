/**
 * The archive reset: remove every article, its media, and the taxonomy around it.
 *
 * ## Why this exists as an operation rather than as a `DELETE FROM articles`
 *
 * The D1 half is genuinely one statement — every child table declares
 * `ON DELETE CASCADE` on `article_id`, so deleting the article rows takes
 * `article_versions`, `media_objects`, `article_tags`, `curation_events`,
 * `article_metrics` and `saved_articles` with them. What that leaves is the part no
 * cascade can reach: **R2**. Each R2 key is derived from the article id
 * (`articles/{id}/…`, SPEC §8), so the `articles` rows are the only pointer to those
 * objects. Delete the rows first and the bytes become unreachable and unidentifiable —
 * `findOrphanedPrefixes` will report them as orphans, but nothing maps an orphan back
 * to what it was.
 *
 * So this runs in the same order as `deleteArticleEverywhere`, and for the same reason:
 * **enumerate R2 first, delete R2, then delete the rows.** A failure in the R2 sweep
 * aborts before any row is gone, so the operation is retryable rather than
 * half-completed.
 *
 * ## Why it is not the existing purge endpoint
 *
 * `POST /api/admin/maintenance/purge-prefix` deliberately refuses a prefix whose D1 row
 * is real content, and that guard is correct — it is what stops the smoke scripts, or a
 * mistyped id, from erasing a capture nobody asked to erase. This is the different,
 * deliberate act: an operator asking for the whole archive to be emptied. Putting it
 * behind that guard would mean weakening the guard for everyone; putting it in its own
 * endpoint means the destructive path is named, confirmed, and auditable on its own.
 *
 * ## What it does not touch
 *
 * `users`, `user_identities`, `user_sessions` and `oauth_states` are reader accounts, not
 * archive content — a reset of the archive is not a reason to log every reader out or
 * destroy their identities. `d1_migrations` is the schema's own bookkeeping. Both are
 * left alone, and the result reports them so the caller can see that.
 *
 * `saved_articles` rows disappear through the `article_id` cascade, which is correct:
 * a save is a pointer to an article, and there is no article left to point at.
 */

import { log } from '../lib/logger';

export interface TeardownCounts {
  articles: number;
  versions: number;
  mediaObjects: number;
  articleTags: number;
  curationEvents: number;
  articleMetrics: number;
  saveRows: number;
  crawlJobs: number;
  categories: number;
  tags: number;
  authors: number;
}

export interface TeardownResult {
  /** The counts as they were *before* the delete, since afterwards they are all zero. */
  removed: TeardownCounts;
  r2: { objects: number; bytes: number };
  /**
   * Rows that survive because they are not archive content.
   *
   * `categories` is here rather than in `removed` even though the rows are briefly deleted:
   * the seeded categories are the schema's baseline and are re-inserted in the same
   * batch, so reporting them as removed would describe a state the database never observably
   * had. `users` and the session tables are simply never touched.
   */
  retained: { users: number; identities: number; sessions: number; categories: number };
}

/**
 * Count what a reset would remove, without removing it.
 *
 * Read first for the same reason `summarizeForDelete` does: the numbers in the result
 * have to describe what *was* there, and after the cascade every one of them is zero.
 * Separated from the delete so a caller can report the size of the operation — and so
 * the confirmation can state a number rather than a warning — before committing to it.
 */
export async function summarizeTeardown(env: Env): Promise<TeardownCounts & { r2: { objects: number; bytes: number } }> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM articles)        AS articles,
       (SELECT COUNT(*) FROM article_versions) AS versions,
       (SELECT COUNT(*) FROM media_objects)   AS mediaObjects,
       (SELECT COUNT(*) FROM article_tags)    AS articleTags,
       (SELECT COUNT(*) FROM curation_events) AS curationEvents,
       (SELECT COUNT(*) FROM article_metrics) AS articleMetrics,
       (SELECT COUNT(*) FROM saved_articles)  AS saveRows,
       (SELECT COUNT(*) FROM crawl_jobs)      AS crawlJobs,
       (SELECT COUNT(*) FROM categories)      AS categories,
       (SELECT COUNT(*) FROM tags)            AS tags,
       (SELECT COUNT(*) FROM authors)         AS authors`,
  ).first<TeardownCounts>();

  // Everything the archive owns lives under `articles/`; nothing else writes to this
  // bucket (see the `ARCHIVE` binding and the key builder in services/media.ts).
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: 'articles/', limit: 1000, cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    articles: counts?.articles ?? 0,
    versions: counts?.versions ?? 0,
    mediaObjects: counts?.mediaObjects ?? 0,
    articleTags: counts?.articleTags ?? 0,
    curationEvents: counts?.curationEvents ?? 0,
    articleMetrics: counts?.articleMetrics ?? 0,
    saveRows: counts?.saveRows ?? 0,
    crawlJobs: counts?.crawlJobs ?? 0,
    categories: counts?.categories ?? 0,
    tags: counts?.tags ?? 0,
    authors: counts?.authors ?? 0,
    r2: { objects, bytes },
  };
}

/**
 * Empty the archive.
 *
 * Order is the correctness argument, and it is the same one `deleteArticleEverywhere`
 * makes: R2 first, rows second. A failure between the two leaves objects deleted but
 * rows present, which is *recoverable* — a re-crawl repopulates the media — whereas the
 * reverse loses the mapping and is not.
 *
 * The taxonomy (`categories`, `tags`, `authors`) has no foreign key into `articles`, so
 * it would survive an article delete. It is removed explicitly because the request is a
 * reset rather than an unlink: a category with no articles is not a category, and the
 * same is true of a tag or an author row.
 *
 * **Except the seeded categories, which go straight back.** `0002_seed_categories.sql` and
 * `0014_more_categories.sql` together are the schema's own baseline — eight fixed categories
 * that the application assumes exist, and
 * that `seed-demo.ts` resolves through a subquery on their slug. Deleting them and stopping
 * there leaves the app seeding articles with a null `category_id` and `/category/ai`
 * returning 404, which is not a reset but a broken install: the acceptance script caught
 * exactly that. So the delete and the re-insert are in the same batch — the rows are gone
 * for no observable moment, and the result reports them as retained rather than removed.
 *
 * `crawl_jobs` is the one table that names an `article_id` without declaring a foreign
 * key to it — the column is a plain string — so its rows would also outlive the articles
 * that spawned them. Deleted explicitly, before the articles, so a job can never point
 * at a row that is already gone.
 */
export async function teardownArchive(env: Env, actor: string): Promise<TeardownResult> {
  const before = await summarizeTeardown(env);

  // --- R2 first. Nothing below this line runs if the sweep throws.
  let deleted = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: 'articles/', limit: 1000, cursor });
    // A page is deleted as one unit: `Promise.all` over the keys, so a 1000-object page
    // is one round of concurrency rather than a thousand sequential awaits.
    await Promise.all(page.objects.map((o) => env.ARCHIVE.delete(o.key)));
    deleted += page.objects.length;
    bytes += page.objects.reduce((sum, o) => sum + o.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // --- then the rows. One `batch` so the whole teardown is a single transaction: D1
  // rejects an explicit `BEGIN`/`COMMIT`, and a half-applied reset would leave articles
  // whose jobs and taxonomy are gone.
  const retained = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users)           AS users,
       (SELECT COUNT(*) FROM user_identities) AS identities,
       (SELECT COUNT(*) FROM user_sessions)   AS sessions`,
  ).first<{ users: number; identities: number; sessions: number }>();

  await env.DB.batch([
    // Jobs before articles: the column is not a declared foreign key, so the cascade
    // does not cover it and a job left behind would name a row that no longer exists.
    env.DB.prepare('DELETE FROM crawl_jobs'),
    // The articles row, and through the cascade: article_versions, media_objects,
    // article_tags, curation_events, article_metrics, saved_articles.
    env.DB.prepare('DELETE FROM articles'),
    // Taxonomy, which nothing cascades from.
    env.DB.prepare('DELETE FROM authors'),
    env.DB.prepare('DELETE FROM tags'),
    env.DB.prepare('DELETE FROM categories'),
    // ...and the seeded categories straight back, in the same batch, because they are
    // the schema's baseline rather than content. Duplicating 0002 and 0014 here is the cost of
    // D1 having no way to re-run a migration on demand; the alternative is leaving the install
    // without the taxonomy the application and the demo seeder both resolve by slug.
    env.DB.prepare(
      `INSERT INTO categories (id, slug, name, description, sort_order, created_at) VALUES
         ('cat_ai',         'ai',         'AI',         'Models, agents, coding, robotics and the AI industry.',               10, 1759000000000),
         ('cat_technology', 'technology', 'Technology', 'Developer tools, hardware, semiconductors, cloud and open source.',     20, 1759000000000),
         ('cat_business',   'business',   'Business',   'Startups, SaaS, venture, strategy and markets.',                      30, 1759000000000),
         ('cat_science',    'science',    'Science',    'Biology, physics, space and mathematics.',                            40, 1759000000000),
         ('cat_ideas',      'ideas',      'Ideas',      'Philosophy, arguments about thinking, work and the future.',          50, 1759000000000),
         ('cat_gaming',     'gaming',     'Gaming',     'Video games, game studios, esports and the games industry.',          60, 1791849600000),
         ('cat_culture',    'culture',    'Culture',    'Books, film, music, media, language, relationships and social life.', 70, 1791849600000),
         ('cat_lifestyle',  'lifestyle',  'Lifestyle',  'Health, sleep, food, money, safety and the texture of daily life.',   80, 1791849600000)`,
    ),
  ]);

  log.warn('archive_torn_down', {
    actor,
    r2_objects: deleted,
    r2_bytes: bytes,
    articles: before.articles,
    versions: before.versions,
    media_objects: before.mediaObjects,
    article_tags: before.articleTags,
    curation_events: before.curationEvents,
    article_metrics: before.articleMetrics,
    saves: before.saveRows,
    crawl_jobs: before.crawlJobs,
    categories: before.categories,
    tags: before.tags,
    authors: before.authors,
    users_retained: retained?.users ?? 0,
  });

  return {
    removed: {
      articles: before.articles,
      versions: before.versions,
      mediaObjects: before.mediaObjects,
      articleTags: before.articleTags,
      curationEvents: before.curationEvents,
      articleMetrics: before.articleMetrics,
      saveRows: before.saveRows,
      crawlJobs: before.crawlJobs,
      categories: before.categories,
      tags: before.tags,
      authors: before.authors,
    },
    r2: { objects: deleted, bytes },
    retained: {
      users: retained?.users ?? 0,
      identities: retained?.identities ?? 0,
      sessions: retained?.sessions ?? 0,
      // Re-inserted in the same batch, so this is the seeded eight rather than a surviving
      // count — read back rather than assumed, so a future edit to the seed list shows up.
      categories: await countCategories(env),
    },
  };
}

/** How many categories exist now — read back after the batch rather than assumed. */
async function countCategories(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM categories').first<{ n: number }>();
  return row?.n ?? 0;
}
