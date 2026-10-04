import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deSegment, hasCjk, segmentCjk } from '../../src/lib/cjk';
import { buildFtsQuery } from '../../src/db/public';

/**
 * SPEC §12 — search over a mostly-Chinese archive.
 *
 * This exists because search did not work, and did not *look* broken. `articles_fts`
 * was tokenised with `unicode61`, which classifies a CJK ideograph as alphanumeric, so
 * every whitespace-free run of Chinese was indexed as one token: the archived 美股
 * article contains the token `一篇讲清楚美股入门的基本逻辑`, and searching `投资` returned
 * nothing even though the word is in the body. Every Latin query kept working, which
 * is exactly how it survived a phase — the acceptance check searched for `cache`, and
 * the tests for `buildFtsQuery` were all Latin.
 *
 * So the assertions here are deliberately weighted towards the cases that would have
 * caught it: a CJK word buried mid-sentence, a CJK word in the title only, and the
 * false-positive risk that made a phrase mandatory rather than an implicit AND.
 */

describe('segmentCjk', () => {
  it('splits every ideograph into its own token', () => {
    // The whole point: `unicode61` splits on the spaces this leaves, so 投资 becomes
    // two tokens instead of being part of one long clause token.
    expect(segmentCjk('投资')).toBe('投 资');
    expect(segmentCjk('你好世界')).toBe('你 好 世 界');
  });

  it('leaves Latin text byte-identical', () => {
    // An English-only article must index exactly as it did before this change, or every
    // existing English result would silently change rank.
    for (const text of ['agents and velocity', 'Claude Code', 'Gemini 4 Pro', 'ETF', 'a1b2 c3d4']) {
      expect(segmentCjk(text), text).toBe(text);
    }
  });

  it('segments a mixed-script run at every boundary', () => {
    // `AI编程hello` as one token would make 编程 unfindable, so the separator has to go
    // either side of an ideograph even where a Latin character is adjacent.
    expect(segmentCjk('AI编程hello')).toBe('AI 编 程 hello');
    expect(segmentCjk('美股 ETF')).toBe('美 股 ETF');
  });

  it('does not double the spaces it did not add', () => {
    expect(segmentCjk('美  股')).toBe('美 股');
    expect(segmentCjk('  投资  ')).toBe('投 资');
    expect(segmentCjk('a  b 投资')).toBe('a b 投 资');
  });

  it('is idempotent, so a re-run cannot double-space the index', () => {
    // The backfill script re-segments whatever it finds, and the parse path can run
    // again over an already-segmented column in a future refactor.
    for (const text of ['投资', '美股 ETF', 'AI编程hello', '你好世界，再见', '  投资  ']) {
      const once = segmentCjk(text);
      expect(segmentCjk(once), text).toBe(once);
    }
  });

  it('covers kana and hangul, which break the same way', () => {
    // Same root cause, different script: `unicode61` treats all of them as
    // alphanumeric. A CJK-only fix would leave Japanese and Korean just as broken.
    expect(segmentCjk('ひらがな')).toBe('ひ ら が な');
    expect(segmentCjk('한국어')).toBe('한 국 어');
    expect(hasCjk('カタカナ')).toBe(true);
    expect(hasCjk('plain latin')).toBe(false);
  });
});

describe('deSegment', () => {
  it('undoes the segmentation on snippet output', () => {
    expect(deSegment('投 资')).toBe('投资');
    expect(deSegment('你 好 世 界 ， 再 见')).toBe('你好世界，再见');
  });

  it('steps over the mark tags snippet puts around a match', () => {
    // `snippet()` wraps the matched phrase, so a space can end up next to a tag rather
    // than next to a character. A pattern that only inspects characters misses those,
    // and the preview comes out as `美 <mark>投 资</mark> 股` with the spaces still there.
    expect(deSegment('美 <mark>投 资</mark> 股')).toBe('美<mark>投资</mark>股');
    expect(deSegment('<mark>你 好</mark> 世 界')).toBe('<mark>你好</mark>世界');
  });

  it('leaves Latin spacing alone', () => {
    expect(deSegment('claude code')).toBe('claude code');
    expect(deSegment('agents and velocity')).toBe('agents and velocity');
    expect(deSegment('a  b')).toBe('a  b');
  });

  it('is the documented approximation, not an exact inverse', () => {
    // Segmented text cannot say whether a space was inserted or written, so a genuine
    // space beside an ideograph goes too. Stated here so the limitation is a test and
    // not a surprise in a screenshot.
    expect(deSegment('美 股 ETF')).toBe('美股ETF');
    expect(deSegment('美 股')).toBe('美股');
  });
});

describe('buildFtsQuery', () => {
  it('quotes Latin words and ANDs them, which is what two words means', () => {
    // Unchanged from before this work — the regression to avoid is breaking the half
    // that worked.
    expect(buildFtsQuery('agents')).toBe('"agents"');
    expect(buildFtsQuery('ai agents')).toBe('"ai" "agents"');
    expect(buildFtsQuery('agents velocity')).toBe('"agents" "velocity"');
  });

  it('turns a CJK word into ONE phrase of consecutive tokens', () => {
    // The distinction that makes this correct rather than merely better. `"投" "资"`
    // would be satisfied by an article mentioning 投 and 资 in unrelated sentences — a
    // search that invents a hit is worse than one that misses.
    expect(buildFtsQuery('投资')).toBe('"投 资"');
    expect(buildFtsQuery('你好世界')).toBe('"你 好 世 界"');
  });

  it('keeps a no-space CJK run as one run, and in order', () => {
    // A reader who types four characters with no spaces means that exact sequence.
    expect(buildFtsQuery('世界你好')).toBe('"世 界 你 好"');
    expect(buildFtsQuery('世界你好')).not.toBe(buildFtsQuery('你好世界'));
  });

  it('mixes scripts without losing either behaviour', () => {
    // Case is preserved on the way in because FTS5 folds ASCII case itself; lowercasing
    // here would be redundant and would corrupt the CJK path for no gain.
    expect(buildFtsQuery('Claude 投资')).toBe('"Claude" "投 资"');
    expect(buildFtsQuery('投资 ETF')).toBe('"投 资" "ETF"');
  });

  it('still strips FTS metacharacters from a CJK word', () => {
    expect(buildFtsQuery('投*资')).toBe('"投 资"');
    expect(buildFtsQuery('"投"')).toBe('"投"');
  });

  it('still returns nothing for input that is only syntax', () => {
    for (const input of ['', '   ', '***', '"', '-']) {
      expect(buildFtsQuery(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('caps the token count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    expect(buildFtsQuery(many)!.split(' ')).toHaveLength(12);
  });
});

describe('the index writers', () => {
  const read = (path: string) => readFileSync(resolve(path), 'utf8');

  /**
   * A source file with its comments removed.
   *
   * Two of the assertions below are negative — "must not mention X" — and both trip on
   * the comment that explains why X is forbidden. Stripping first is what makes them
   * about the code instead of about the documentation of the code.
   *
   * `--` goes as well as `//`, because the SQL here lives inside template literals where
   * `--` is a real SQL comment — which is also why the forbidden snippet call was still
   * visible after the first attempt: it was sitting in one, explaining itself.
   */
  const code = (path: string) =>
    read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  /**
   * The invariant the migration's `COALESCE` fallback cannot enforce.
   *
   * The trigger reads `COALESCE(new.fts_title, new.title)`, so a writer that sets
   * `title` without its twin leaves the index holding the *previous* title — not an
   * error, just a quietly stale result. This fails if that happens, because the whole
   * class of bug is a change nobody notices until a search is wrong.
   */
  it('writes the segmented twin whenever it writes the source column', () => {
    const twins: Record<string, string> = {
      title: 'fts_title',
      excerpt: 'fts_excerpt',
      author_name: 'fts_author_name',
      author_username: 'fts_author_username',
      content_text: 'fts_content',
      tags_text: 'fts_tags',
    };

    const sources = ['src/services/parse.ts', 'src/services/crawl.ts', 'src/services/seed-demo.ts'];
    let checked = 0;

    for (const file of sources) {
      const source = read(file);
      for (const block of source.matchAll(/(?:UPDATE|INSERT INTO|INSERT OR IGNORE INTO)\s+articles[\s\S]*?(?=`\s*(?:\)|;|,?\s*$))/g)) {
        const sql = block[0];
        for (const [source_column, twin] of Object.entries(twins)) {
          // `\b` after the name so `fts_title` does not count as a write to `title`.
          const writesSource = new RegExp(`(^|[\\s,(])${source_column}\\s*=`, 'm').test(sql);
          const writesTwin = new RegExp(`(^|[\\s,(])${twin}\\s*=`, 'm').test(sql);
          if (!writesSource) continue;
          checked++;
          expect(writesTwin, `${file}: sets ${source_column} without ${twin}`).toBe(true);
        }
      }
    }
    // If the pattern stopped matching anything the test would pass vacuously.
    expect(checked, 'no indexed column writes were found to check').toBeGreaterThan(5);
  });

  it('segments at every place that fills an indexed column', () => {
    // The value has to be segmented on the way in, not on the way out: the index stores
    // the segmented form and there is no other opportunity to do it.
    for (const file of ['src/services/parse.ts', 'src/services/crawl.ts', 'src/services/seed-demo.ts']) {
      expect(read(file), `${file} imports the segmenter`).toContain("from '../lib/cjk'");
    }
    const search = read('src/db/public.ts');
    expect(search).toContain("from '../lib/cjk'");
    expect(search).toContain('deSegment(r.snippet)');
  });

  it('addresses the snippet column positionally, because naming it silently fails', () => {
    // Both halves of a fragile pairing, pinned together.
    //
    // `snippet(articles_fts, 'fts_content', …)` looks like the robust choice. It is not:
    // this SQLite build does not resolve the column name and falls back to column 0,
    // which is the UNINDEXED article_id — so every result previewed as `art_7i7n5…`
    // instead of the sentence that matched. No error, no failed query, and a test that
    // asserted the *broken* string was present. Verified against SQLite directly:
    //
    //   by name   -> art_ABC123
    //   by index  -> 小 白 入 门 <mark>美 股</mark> 指 南…
    //
    // So the index is positional and the column order below is what makes it mean
    // something. Reordering the FTS columns without touching the query would point the
    // snippet at the wrong field, which is why this asserts both.
    const search = code('src/db/public.ts');
    const migration = read('migrations/0007_cjk_search.sql');

    expect(search).toMatch(/snippet\(articles_fts,\s*3,/);
    expect(search).not.toMatch(/snippet\(articles_fts,\s*'/);

    const columns = /CREATE VIRTUAL TABLE articles_fts USING fts5\(([\s\S]*?)\)\s*;/.exec(migration)?.[1] ?? '';
    const order = columns
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      // The `tokenize = …` option is not a column.
      .filter((c) => !/^tokenize/i.test(c));
    expect(order[0]).toMatch(/^article_id UNINDEXED$/);
    expect(order[3], 'the snippet column must stay fourth').toMatch(/^fts_content$/);
  });

  it('keeps the index-only columns out of anything that reads articles', () => {
    // `content_text` was renamed rather than copied precisely because nothing SELECTed
    // it. If a query starts selecting `fts_content` the body ships to the page, because
    // `listArticles` uses `a.*` and the public API projects explicitly to avoid exactly
    // that (SPEC §22).
    //
    // Checked with the comments stripped: the file's own doc comment names the column in
    // order to explain why the projection exists, so a plain substring search fails on
    // the explanation of the thing it is checking.
    const codeText = code('src/routes/public-api.ts');
    expect(codeText).not.toContain('fts_content');
    expect(codeText).not.toContain('content_text');
    expect(codeText).not.toMatch(/\bfts_[a-z_]+/);
  });
});