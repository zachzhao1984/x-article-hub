import { describe, expect, it } from 'vitest';
import { detectLanguage, languageSample, LANGUAGE_LABELS } from '../../src/lib/language';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §15 — the language badge.
 *
 * The archive is genuinely multilingual — measured over the first hundred imported articles,
 * 57 are Latin-script, 32 carry Japanese kana, and 11 are Han-only Chinese — so the detector
 * has to get those three apart correctly, and the tests use real titles from the archive
 * rather than invented ones.
 *
 * The judgement call worth pinning is the kana-over-Han ordering. A Japanese sentence full of
 * kanji contains Han ideographs, so a detector that checked Han first would label it Chinese.
 * Kana appear in Japanese and never in Chinese, which is what makes them the decisive signal.
 */

const parseSrc = readFileSync(resolve('src/services/parse.ts'), 'utf8');
const schema = readFileSync(resolve('migrations/0013_article_language.sql'), 'utf8');

describe('detectLanguage', () => {
  it('detects Japanese from kana, even when kanji dominate', () => {
    // Real titles from the archive. The second is mostly kanji with the kana that decide it.
    expect(detectLanguage('女は押され続けると好きになる')).toBe('ja');
    expect(detectLanguage('三日坊主と自律神経の関係と対処法')).toBe('ja');
    // Katakana-only loanwords are still Japanese.
    expect(detectLanguage('メッシの代表引退スピーチ')).toBe('ja');
  });

  it('detects Chinese from Han with no kana', () => {
    // The decisive difference from Japanese: Han ideographs alone.
    expect(detectLanguage('任何人都能复刻的Claude注册、订阅和过KYC防封号教程')).toBe('zh');
  });

  it('detects Korean from Hangul', () => {
    expect(detectLanguage('안녕하세요')).toBe('ko');
  });

  it('falls back to latin for anything without those scripts', () => {
    // Not "English" — the detector does not separate Latin languages, and saying `en` for a
    // Spanish article would be a wrong claim rather than a coarse one.
    expect(detectLanguage('Is The Assembly worth it?')).toBe('latin');
    expect(detectLanguage('Mafia III | October 2026 Update Notes')).toBe('latin');
    // An empty string is the same default rather than a crash.
    expect(detectLanguage('')).toBe('latin');
  });

  it('prefers Japanese over Chinese when both scripts are present', () => {
    // This is the ordering that matters: Japanese text contains Han, so checking Han first
    // would mislabel every kanji-heavy Japanese article.
    const mixed = '視点・視野・視座についてのまとめメモ';
    expect(detectLanguage(mixed)).toBe('ja');
  });
});

describe('languageSample', () => {
  it('includes the title and the body, because either alone can mislead', () => {
    // A Japanese article with an English title must still be detected as Japanese, which
    // needs the body in the sample.
    const sample = languageSample('The Future of AI', 'これは日本語の記事です。');
    expect(detectLanguage(sample)).toBe('ja');
  });

  it('works with only a title, before a body has been parsed', () => {
    expect(detectLanguage(languageSample('好きな人に送ると返しにくい5つのLINE', null))).toBe('ja');
  });

  it('caps the body so a long article is not scanned whole', () => {
    // A language is a property of the whole text and the opening carries every script used.
    const body = 'x'.repeat(100_000);
    const sample = languageSample('T', body, 100);
    expect(sample.length).toBeLessThan(200);
  });
});

describe('labels', () => {
  it('has a label for every detectable language', () => {
    for (const lang of ['zh', 'ja', 'ko', 'latin'] as const) {
      expect(LANGUAGE_LABELS[lang], `no label for ${lang}`).toBeTruthy();
    }
  });

  it('uses the language name, not the country', () => {
    // 中文 not 中国, 日本語 not 日本: the badge names a language.
    expect(LANGUAGE_LABELS.zh).toBe('中文');
    expect(LANGUAGE_LABELS.ja).toBe('日本語');
  });
});

describe('wiring', () => {
  it('is stored on the article at parse time', () => {
    // The parser is where the document text is in hand; detecting at read time would scan
    // every body on every list render.
    expect(parseSrc).toMatch(/detectLanguage\(languageSample\(/);
    expect(parseSrc).toMatch(/lang = \?14/);
  });

  it('has a backfill for articles parsed before the column existed', () => {
    // The detector lives in the parser, so rows parsed earlier have `lang IS NULL`. The
    // backfill takes the *same* sample the parser does, so a backfilled article and a freshly
    // parsed one cannot disagree — which is why both call `languageSample`.
    const apiSrc = readFileSync(resolve('src/routes/admin-api.ts'), 'utf8');
    const backfill = apiSrc.slice(apiSrc.indexOf('backfill-language'));
    expect(backfill).toMatch(/lang IS NULL/);
    expect(backfill).toMatch(/detectLanguage\(languageSample\(/);
    // And it must not re-parse: the parse output is unchanged, so only `lang` is written.
    expect(backfill).toMatch(/UPDATE articles SET lang = \?2/);
  });

  it('is a nullable column with a constrained vocabulary', () => {
    // NULL means "not parsed yet" — a default of 'latin' would make every unparsed row claim
    // to be Latin-script and the backfill could not tell which rows it had looked at.
    expect(schema).toMatch(/ADD COLUMN lang TEXT/);
    expect(schema).toMatch(/CHECK \(lang IN \('zh', 'ja', 'ko', 'latin'\)\)/);
    expect(schema).not.toMatch(/DEFAULT 'latin'/);
  });
});
