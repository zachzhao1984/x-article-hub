import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextStatusAfterCrawl } from '../../src/services/crawl';
import { publishParsedArticle } from '../../src/services/parse';

const parseSource = readFileSync(resolve('src/services/parse.ts'), 'utf8');

function publicationDb(initialStatus: string, opts: { content?: boolean; blocks?: number; mode?: string } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE articles (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER,
    raw_r2_key TEXT, content_r2_key TEXT, block_count INTEGER, display_mode TEXT
  );
  CREATE TABLE curation_events (
    id TEXT PRIMARY KEY, article_id TEXT, action TEXT, actor TEXT, note TEXT, created_at INTEGER
  );
  CREATE TABLE article_versions (article_id TEXT, version INTEGER);`);
  sqlite.prepare(`INSERT INTO article_versions VALUES ('art_test', 1)`).run();
  sqlite.prepare(`INSERT INTO articles VALUES (?, ?, 0, 'raw.json', ?, ?, ?)`)
    .run('art_test', initialStatus, opts.content === false ? null : 'articles/art_test/versions/v1/article.json', opts.blocks ?? 2, opts.mode ?? 'full');

  // Execute the same SQL and parameters as the production D1 batch. Each job
  // commits in one SQLite transaction, matching D1's documented batch behavior.
  const db = {
    prepare(sql: string) {
      return { bind: (...params: unknown[]) => ({ sql, params }) };
    },
    async batch(stmts: Array<{ sql: string; params: unknown[] }>) {
      sqlite.exec('BEGIN');
      try {
        const results = stmts.map(({ sql, params }) => ({
          meta: { changes: Number(sqlite.prepare(sql).run(...(params as string[])).changes) },
        }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, env: { DB: db } as unknown as Env };
}

describe('automatic publication after parsing', () => {
  it('publishes a completed import once and records who did it', async () => {
    const { sqlite, env } = publicationDb('review');
    expect(await publishParsedArticle(env, 'art_test')).toBe(true);
    expect(await publishParsedArticle(env, 'art_test')).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM articles WHERE id = 'art_test'`).get()?.status).toBe('published');
    expect(sqlite.prepare(`SELECT action, actor FROM curation_events`).all()).toEqual([
      { action: 'publish', actor: 'system:parse' },
    ]);
    sqlite.close();
  });

  it('recovers a parsed import stranded in failed', async () => {
    const { sqlite, env } = publicationDb('failed');
    expect(await publishParsedArticle(env, 'art_test')).toBe(true);
    expect(sqlite.prepare(`SELECT status FROM articles`).get()?.status).toBe('published');
    sqlite.close();
  });

  it('does not publish an older document when a newer crawl has arrived', async () => {
    const { sqlite, env } = publicationDb('review');
    sqlite.prepare(`INSERT INTO article_versions VALUES ('art_test', 2)`).run();
    expect(await publishParsedArticle(env, 'art_test')).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM articles`).get()?.status).toBe('review');
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM curation_events`).get()?.n).toBe(0);
    sqlite.close();
  });

  it.each(['pending', 'fetching', 'published', 'rejected', 'archived', 'takedown'])
  ('does not overwrite %s, including editorial decisions', async (status) => {
    const { sqlite, env } = publicationDb(status);
    expect(await publishParsedArticle(env, 'art_test')).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM articles`).get()?.status).toBe(status);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM curation_events`).get()?.n).toBe(0);
    sqlite.close();
  });

  it.each([
    { content: false },
    { blocks: 0 },
    { mode: 'takedown' },
  ])('keeps incomplete or taken-down imports private (%j)', async (options) => {
    const { sqlite, env } = publicationDb('review', options);
    expect(await publishParsedArticle(env, 'art_test')).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM articles`).get()?.status).toBe('review');
    sqlite.close();
  });

  it('preserves editorial states across re-crawls', () => {
    for (const status of ['published', 'rejected', 'archived', 'takedown']) {
      expect(nextStatusAfterCrawl(status)).toBe(status);
    }
    expect(nextStatusAfterCrawl('pending')).toBe('review');
    expect(nextStatusAfterCrawl('failed')).toBe('review');
  });

  it('runs in the parse service on both successful parse paths', () => {
    expect(parseSource.match(/await publishParsedArticle\(env, articleId\)/g)).toHaveLength(2);
    expect(parseSource.lastIndexOf('await publishParsedArticle(env, articleId)'))
      .toBeGreaterThan(parseSource.indexOf('writeArticleDocument'));
    expect(parseSource.indexOf('document.blocks.length === 0'))
      .toBeLessThan(parseSource.indexOf('writeArticleDocument(env.ARCHIVE'));
  });
});
