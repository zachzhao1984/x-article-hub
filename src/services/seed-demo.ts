/**
 * Demo content for validating the public site.
 *
 * This is NOT crawled content. It exists because the crawl pipeline is Phase 2
 * and the public site needs published rows to be verifiable at all. Every row is
 * marked with `demo = 1` semantics (source_url host is `example.com` for the
 * fictional authors, and the ids are clearly synthetic) so it can never be
 * confused with a real archive, and `--reset` removes exactly this set.
 *
 * SPEC §4.7 — the human decides what is published. Here that human is this script.
 */

import { R2_PATHS, countWords, documentToPlainText } from '../types/article-document';
import type { ArticleDocument } from '../types/article-document';
import { newId } from '../lib/ids';
import { sha256Hex } from '../lib/hash';
import { segmentCjk } from '../lib/cjk';
import { recordEvent } from '../db/events';
import { rankingWeights } from '../config/ranking';
import { combineScores, rawPopularity, normalizeScores, clampQuality } from '../ranking/score';
import type { Metrics } from '../ranking/score';

interface SeedArticle {
  username: string;
  displayName: string;
  xArticleId: string;
  title: string;
  excerpt: string;
  category: 'ai' | 'technology' | 'business' | 'science' | 'ideas';
  tags: string[];
  topics: string[];
  summary: string;
  quality: { information_density: number; originality: number; insight: number; actionability: number; overall: number };
  metrics: Omit<Metrics, 'capturedAt'>;
  previous: Omit<Metrics, 'capturedAt'>;
  featured: boolean;
  hoursAgo: number;
  body: string[];
}

const HOUR = 60 * 60 * 1000;

const ARTICLES: SeedArticle[] = [
  {
    username: 'demo_karpathy',
    displayName: 'Demo Karpathy',
    xArticleId: '9000000000000000001',
    title: 'Agents Are Just Programs That Keep Going',
    excerpt:
      'The interesting part of an agent is not the model. It is the loop, the tool surface, and the failure modes you design for.',
    category: 'ai',
    tags: ['Agents', 'LLM', 'Architecture'],
    topics: ['Agents', 'Models'],
    summary:
      'Argues that the durable value in agent systems comes from the surrounding harness — loop design, tool boundaries, and explicit handling of partial failure — rather than from model capability alone.',
    quality: { information_density: 88, originality: 72, insight: 90, actionability: 64, overall: 80 },
    metrics: { likes: 4820, reposts: 1290, replies: 312, quotes: 190, bookmarks: 940, views: 210000 },
    previous: { likes: 4310, reposts: 1105, replies: 268, quotes: 160, bookmarks: 850, views: 176000 },
    featured: true,
    hoursAgo: 30,
    body: [
      'The word "agent" has been stretched until it means almost nothing. Strip away the vendor framing and an agent is a program that keeps running after it hands work back to itself.',
      'That framing sounds almost trivial, and it should. But most of the engineering in a real agent system lives in exactly the parts that trivial description hides.',
      '## The loop is the product',
      'A loop needs a stopping condition that is not "the model decided to stop." Without one, you get either a runaway process or a system that quits during the interesting part of the task.',
      'Three stopping conditions have held up well in practice:',
      'A budget of tool calls, a wall-clock deadline, and an explicit success predicate the model cannot write itself.',
      'Each one fails differently. A call budget punishes tasks that legitimately need many cheap calls. A deadline punishes tasks with a slow tail. A success predicate punishes tasks where nobody wrote down what success means.',
      '## Tool boundaries decide everything',
      'The set of tools you expose is the actual capability surface of the system. Adding a tool is cheap; removing one is a design decision with security consequences.',
      '> The model is not the product. The loop, the tool surface, and the failure modes are the product.',
      '## What I would measure',
      'Not task success rate in isolation. I want to know how often the system terminates for the wrong reason, because that number compounds across every downstream use.',
    ],
  },
  {
    username: 'demo_bengio',
    displayName: 'Demo Researcher',
    xArticleId: '9000000000000000002',
    title: 'Inference Cost Is an Architecture Decision',
    excerpt:
      'Serving cost is not a property of the model. It is a property of the system you build around it, and it is decided long before the model is chosen.',
    category: 'ai',
    tags: ['Inference', 'Infrastructure', 'Cost'],
    topics: ['Models', 'AI Business'],
    summary:
      'Breaks inference cost into prefill, decode, and memory-bandwidth terms, and argues that most production surprises come from workload shape and batching rather than from raw model size.',
    quality: { information_density: 91, originality: 78, insight: 84, actionability: 79, overall: 85 },
    metrics: { likes: 3140, reposts: 880, replies: 240, quotes: 210, bookmarks: 1120, views: 148000 },
    previous: { likes: 2960, reposts: 812, replies: 221, quotes: 190, bookmarks: 1040, views: 131000 },
    featured: false,
    hoursAgo: 12,
    body: [
      'Teams ask what a model costs per million tokens, then discover the real number months later. The per-token figure is the least important term.',
      '## Two different bills',
      'Prefill is compute-bound: you are pushing a long prompt through a wide matmul and the hardware stays busy. Decode is memory-bound: each new token touches every weight and then waits.',
      'This asymmetry explains most of what looks like magic in serving stacks. Continuous batching, speculative decoding, and KV-cache reuse are all attacks on the decode phase specifically.',
      '## Workload shape matters more than model size',
      'A small model serving long-context summarization at high concurrency can be more expensive than a large model serving short classification requests, because you are paying for prefill either way.',
      'Measure the shape before you measure the model:',
      'Average prompt length, output length distribution, request arrival pattern, and how much of the context is shared across requests.',
      '## Practical order of operations',
      'Start by caching what is genuinely cacheable. A shared system prompt on every request is free money if your provider supports prefix caching. Then look at output length distribution, because the tail is what breaks your unit economics.',
    ],
  },
  {
    username: 'demo_saul',
    displayName: 'Demo Platform Engineer',
    xArticleId: '9000000000000000003',
    title: 'Your Database Is Not Your Cache',
    excerpt:
      'A short argument for treating caching as an explicit, measured layer instead of an emergent property of your database configuration.',
    category: 'technology',
    tags: ['Databases', 'Caching', 'Performance'],
    topics: ['Cloud', 'Developer Tools'],
    summary:
      'Argues that conflating the database with the cache produces unpredictable invalidation, and proposes measuring hit ratio and staleness as first-class service metrics.',
    quality: { information_density: 76, originality: 84, insight: 79, actionability: 88, overall: 82 },
    metrics: { likes: 2280, reposts: 690, replies: 180, quotes: 140, bookmarks: 810, views: 96000 },
    previous: { likes: 2150, reposts: 640, replies: 168, quotes: 128, bookmarks: 770, views: 91000 },
    featured: false,
    hoursAgo: 6,
    body: [
      'The phrase "just add an index" hides a design decision. The phrase "just enable the cache" hides another one. Both are fine, and both deserve to be written down.',
      '## Invalidation is the actual design work',
      'A cache without an explicit staleness budget is a correctness bug waiting for a traffic spike. Decide, per data class, how wrong it is allowed to be and for how long.',
      'For a lot of product surfaces the honest answer is "seconds", which is easy. For anything a person makes a decision on, the answer is usually "none", and you need a different strategy.',
      '## Measure two things, not one',
      'Hit ratio tells you whether the cache is doing anything. Staleness tells you whether it is doing anything *correctly*. Teams almost always track the first.',
      '## The uncomfortable part',
      'If your hit ratio is low, the cache is not the problem. The problem is that your access pattern has less reuse than you assumed, and the cache is making that visible.',
    ],
  },
  {
    username: 'demo_surya',
    displayName: 'Demo Founder',
    xArticleId: '9000000000000000004',
    title: 'The Market for Boring Infrastructure',
    excerpt:
      'Why the least glamorous layer of the stack keeps producing the most durable companies, and what that implies for where to build.',
    category: 'business',
    tags: ['Strategy', 'Infrastructure', 'Markets'],
    topics: ['Strategy', 'Startup'],
    summary:
      'Contrasts infrastructure businesses with model-layer businesses and argues that switching costs and operational depth produce a different and more durable competitive position.',
    quality: { information_density: 68, originality: 86, insight: 82, actionability: 58, overall: 74 },
    metrics: { likes: 1890, reposts: 520, replies: 340, quotes: 95, bookmarks: 430, views: 72000 },
    previous: { likes: 1760, reposts: 470, replies: 305, quotes: 88, bookmarks: 400, views: 68000 },
    featured: true,
    hoursAgo: 20,
    body: [
      'There is a reliable pattern in infrastructure: the product nobody demos at a conference is the product customers renew without a procurement debate.',
      '## Two different games',
      'The model layer rewards speed and tolerates churn. Infrastructure rewards reliability and punishes churn, because the cost of switching is paid in engineering hours rather than in dollars.',
      'That difference shows up in every number that matters. Churn is lower. Pricing power is higher. The sales cycle is shorter, because the buyer is looking to reduce risk rather than to look modern.',
      '## The trap',
      'The trap is believing that boring means safe. Boring infrastructure still fails, and when it fails the customer blames you specifically. You have traded upside for a different job.',
    ],
  },
  {
    username: 'demo_hoshino',
    displayName: 'Demo Physicist',
    xArticleId: '9000000000000000005',
    title: 'Measurement Noise Is a Design Constraint',
    excerpt:
      'An experimental result is a distribution over procedures, not a number. Treating it otherwise is how reproducibility problems start.',
    category: 'science',
    tags: ['Methodology', 'Measurement'],
    topics: ['Physics'],
    summary:
      'Frames measurement as a property of an experimental procedure rather than a property of the world, and derives practical reporting requirements from that framing.',
    quality: { information_density: 84, originality: 70, insight: 86, actionability: 61, overall: 78 },
    metrics: { likes: 1240, reposts: 610, replies: 95, quotes: 130, bookmarks: 520, views: 54000 },
    previous: { likes: 1215, reposts: 596, replies: 92, quotes: 126, bookmarks: 510, views: 52900 },
    featured: false,
    hoursAgo: 48,
    body: [
      'The number in the abstract is a summary of a procedure, not a reading of the world. Once you internalize that, reporting gets much more honest almost for free.',
      '## A result is a distribution over procedures',
      'Change the calibration, the operator, the ambient temperature, and you get a different procedure that is nominally measuring the same quantity.',
      'The spread across those procedures is irreducible. You can shrink the error on any single procedure, but the across-procedure spread stays.',
      '## What to report',
      'Report the procedure, not just the number. Report how many times you repeated it. Report what you excluded and why.',
      '> A number without a procedure is a rumor.',
    ],
  },
  {
    username: 'demo_ishikawa',
    displayName: 'Demo Essayist',
    xArticleId: '9000000000000000006',
    title: 'On Reading Slowly in a Fast Feed',
    excerpt:
      'A short argument that the value of long-form writing depends on an audience willing to stay, and that this is a scarce resource worth designing for.',
    category: 'ideas',
    tags: ['Reading', 'Attention', 'Culture'],
    topics: ['Culture', 'Future'],
    summary:
      'Argues that long-form attention is a fixed and shrinking resource, and that publishing for it is a different discipline from publishing for impressions.',
    quality: { information_density: 62, originality: 88, insight: 80, actionability: 44, overall: 71 },
    metrics: { likes: 980, reposts: 410, replies: 128, quotes: 88, bookmarks: 360, views: 41000 },
    previous: { likes: 940, reposts: 388, replies: 120, quotes: 82, bookmarks: 344, views: 39500 },
    featured: false,
    hoursAgo: 72,
    body: [
      'Long-form writing has an unusual economic structure: it pays out slowly, to fewer people, and it compounds by reputation rather than by reach.',
      '## The scarcity is attention, not readers',
      'There is no shortage of things to read. There is a shortage of people willing to stay with a hard idea for eight minutes.',
      'Designing for that means accepting a smaller audience in exchange for a different relationship with it.',
      '## What this rewards',
      'Clarity about what the reader will be able to do differently afterward. Everything else is decoration.',
    ],
  },
];

/** SPEC §5.2 — demo URLs must be obviously synthetic, so the importer's real URL rules don't apply. */
const DEMO_ORIGIN = 'https://x.com';

export interface SeedResult {
  created: number;
  removed: number;
  articleIds: string[];
}

export async function seedDemoArticles(env: Env, opts: { reset?: boolean } = {}): Promise<SeedResult> {
  const now = Date.now();

  if (opts.reset) await removeDemoArticles(env);

  const weights = rankingWeights(env.RANKING_WEIGHTS_JSON);

  // SPEC §14.1 — scores are normalized across the candidate set, so compute raw
  // values for everything first and only then normalize.
  const metrics: Metrics[] = ARTICLES.map((a) => ({ ...a.metrics, capturedAt: now }));
  const previous: Metrics[] = ARTICLES.map((a) => ({ ...a.previous, capturedAt: now - 6 * HOUR }));

  const rawPop = metrics.map(rawPopularity);
  const pop = normalizeScores(rawPop);
  const quality = ARTICLES.map((a) => a.quality.overall);

  const created: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < ARTICLES.length; i += 1) {
    const a = ARTICLES[i]!;
    const articleId = newId('art');
    const version = 1;
    const contentKey = R2_PATHS.versionJson(articleId, version);
    const canonicalUrl = `${DEMO_ORIGIN}/${a.username}/article/${a.xArticleId}`;
    const publishedAt = now - a.hoursAgo * HOUR;

    const document = buildDocument(a, canonicalUrl, publishedAt);
    const plainText = documentToPlainText(document);
    const words = countWords(plainText);

    await env.ARCHIVE.put(contentKey, JSON.stringify(document), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    await env.ARCHIVE.put(R2_PATHS.versionMarkdown(articleId, version), documentToMarkdown(document), {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });

    const contentHash = await sha256Hex(plainText);
    const sourceHash = await sha256Hex(document.source.url + publishedAt);

    const final = combineScores(
      { popularity: pop[i]!, quality: clampQuality(a.quality.overall), editor: a.featured ? 100 : 0 },
      weights,
    );

    // SPEC §4.7 — the editor has already reviewed this content, so it is published.
    statements.push(
      env.DB.prepare(
        `INSERT INTO articles (
           id, source_url, canonical_url, x_article_id, slug, title, excerpt,
           author_id, author_name, author_username, published_at, imported_at,
           status, category_id, ai_summary, ai_category, ai_confidence,
           quality_score, popularity_score, velocity_score, editor_score, final_score,
           parser_version, content_r2_key, featured, display_mode,
           word_count, block_count, fts_content, fts_tags, created_at, updated_at,
           fts_title, fts_excerpt, fts_author_name, fts_author_username
         ) VALUES (
           ?1, ?2, ?2, ?3, ?4, ?5, ?6,
           ?7, ?8, ?9, ?10, ?11,
           'published', (SELECT id FROM categories WHERE slug = ?12), ?13, ?12, ?14,
           ?15, ?16, ?17, ?18, ?19,
           1, ?20, ?21, 'full',
           ?22, ?23, ?24, ?25, ?26, ?26,
           ?27, ?28, ?29, ?30
         )`,
      ).bind(
        articleId,
        canonicalUrl,
        a.xArticleId,
        `${a.username}-${a.xArticleId}`,
        a.title,
        a.excerpt,
        `aut_${a.username}`,
        a.displayName,
        a.username,
        publishedAt,
        publishedAt,
        a.category,
        a.summary,
        a.quality.overall / 100,
        a.quality.overall,
        pop[i],
        // SPEC §14.4 — velocity is no longer a component of the score, so nothing writes
        // this column. Bound explicitly rather than dropped from the INSERT so the column
        // list and the placeholder count do not depend on the ranking model having a
        // velocity term.
        null,
        a.featured ? 100 : 0,
        final,
        contentKey,
        a.featured ? 1 : 0,
        words,
        document.blocks.length,
        // SPEC §12 — the index-only columns carry the CJK-segmented form, and the
        // displayed columns gain their segmented twins, exactly as the crawl and the
        // Parser write them. The demo set is what the acceptance checks search over,
        // so leaving these raw would make the checks pass for the wrong reason again.
        segmentCjk(plainText),
        segmentCjk(a.tags.join(' ')),
        now,
        segmentCjk(a.title),
        segmentCjk(a.excerpt),
        segmentCjk(a.displayName),
        segmentCjk(a.username),
      ),
    );

    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO authors (id, username, display_name, article_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      ).bind(`aut_${a.username}`, a.username, a.displayName, now),
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO article_versions (id, article_id, version, parser_version, source_hash, content_hash, r2_key, captured_at, created_at)
         VALUES (?1, ?2, 1, 1, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(newId('ver'), articleId, sourceHash, contentHash, contentKey, publishedAt),
    );

    // SPEC §11.7 — two metric samples so velocity is computable (SPEC §14.2).
    statements.push(
      env.DB.prepare(
        `INSERT INTO article_metrics (id, article_id, captured_at, likes, reposts, replies, quotes, bookmarks, views)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(newId('met'), articleId, now - 6 * HOUR, previous[i]!.likes, previous[i]!.reposts, previous[i]!.replies, previous[i]!.quotes, previous[i]!.bookmarks, previous[i]!.views),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO article_metrics (id, article_id, captured_at, likes, reposts, replies, quotes, bookmarks, views)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(newId('met'), articleId, now, metrics[i]!.likes, metrics[i]!.reposts, metrics[i]!.replies, metrics[i]!.quotes, metrics[i]!.bookmarks, metrics[i]!.views),
    );

    // SPEC §13.5 — topics are tags.
    for (const tagName of [...a.tags, ...a.topics]) {
      statements.push(
        env.DB.prepare(`INSERT OR IGNORE INTO tags (id, slug, name, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(
          newId('tag'),
          slugifyTag(tagName),
          tagName,
          now,
        ),
      );
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO article_tags (article_id, tag_id, source, created_at)
           SELECT ?1, id, 'editor', ?2 FROM tags WHERE slug = ?3`,
        ).bind(articleId, now, slugifyTag(tagName)),
      );
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO curation_events (id, article_id, action, actor, note, created_at)
         VALUES (?1, ?2, 'import', 'seed:demo', ?3, ?4)`,
      ).bind(newId('evt'), articleId, 'DEMO CONTENT — not a real crawl', now),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO curation_events (id, article_id, action, actor, note, created_at)
         VALUES (?1, ?2, 'publish', 'seed:demo', 'DEMO CONTENT — published for site validation', ?3)`,
      ).bind(newId('evt'), articleId, now),
    );

    created.push(articleId);

    if (statements.length >= 80) {
      await env.DB.batch(statements.splice(0, statements.length));
    }
  }

  if (statements.length > 0) await env.DB.batch(statements);

  void recordEvent;
  return { created: created.length, removed: 0, articleIds: created };
}

/**
 * Removes only rows this seeder created — `x_article_id` in the 9000… range.
 *
 * SPEC §8 requires raw to be append-only, and this deliberately does not touch R2:
 * an append-only archive is a record of what was captured, and deleting captures
 * because a demo fixture went away would be the wrong trade. The cost is that a
 * demo run leaves an `articles/{id}/` prefix behind, which is why
 * `GET /admin/storage` reports unreachable prefixes rather than pretending they
 * are not there.
 */
export async function removeDemoArticles(env: Env): Promise<number> {
  const { meta } = await env.DB.prepare(`DELETE FROM articles WHERE x_article_id LIKE '9000%'`).run();
  const deleted = (meta.changes ?? 0) as number;
  return deleted;
}

function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildDocument(a: SeedArticle, url: string, publishedAt: number): ArticleDocument {
  const blocks: ArticleDocument['blocks'] = [];

  for (const raw of a.body) {
    if (raw.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, text: raw.slice(3) });
    } else if (raw.startsWith('> ')) {
      blocks.push({ type: 'quote', text: raw.slice(2) });
    } else if (raw.endsWith(':')) {
      blocks.push({ type: 'paragraph', text: raw });
    } else {
      blocks.push({ type: 'paragraph', text: raw });
    }
  }

  return {
    title: a.title,
    author: { name: a.displayName, username: a.username },
    publishedAt: new Date(publishedAt).toISOString(),
    blocks,
    links: [],
    images: [],
    source: { url, parserVersion: 1, capturedAt: new Date(publishedAt).toISOString() },
  };
}

/** SPEC §8 — the markdown mirror of the versioned document. */
function documentToMarkdown(doc: ArticleDocument): string {
  const lines: string[] = [`# ${doc.title}`, '', `> @${doc.author.username} · ${doc.publishedAt ?? ''}`, ''];

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'quote':
        lines.push(`> ${block.text}`, '');
        break;
      case 'list':
        block.items.forEach((item, i) => lines.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`));
        lines.push('');
        break;
      case 'code':
        lines.push('```', block.code, '```', '');
        break;
      case 'paragraph':
        lines.push(block.text, '');
        break;
      default:
        break;
    }
  }

  lines.push(`---`, `Source: ${doc.source.url}`);
  return lines.join('\n');
}
