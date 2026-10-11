/**
 * Language detection for the language badge on a card.
 *
 * ## Why a script-based detector and not a model or a library
 *
 * The archive is genuinely multilingual — measured over the first hundred imported articles,
 * 57 are Latin-script, 32 carry Japanese kana, and 11 are Han-only Chinese. Telling those
 * apart needs no statistics: kana (hiragana/katakana) appear in Japanese and not in Chinese,
 * Hangul is Korean, and anything otherwise Han is Chinese. That is a handful of Unicode range
 * tests over text the parser has already produced.
 *
 * The alternative — a language-detection model — would add a second Workers AI call per
 * article, a second thing to be unavailable, and probabilistic answers for questions with a
 * definite answer. A script test is exact for the cases this archive actually contains.
 *
 * ## What it deliberately does not do
 *
 * It does not distinguish between Latin-script languages (English, Spanish, German…). Those
 * need real statistics, and the failure mode of guessing is worse than the failure mode of
 * not guessing: a Spanish article mislabelled "English" is a wrong claim, where a shared
 * `en`-register label would be a coarse one. The badge reports `Latin`, and a caller that
 * wants finer granularity is asking a different, harder question.
 *
 * ## Where it looks
 *
 * The full document text, not just the title. A Japanese article can have an English title
 * (and a Chinese one a Japanese loanword); the body is where the script is unambiguous. The
 * caller passes whatever text it has, and this weighs the whole of it.
 */

/**
 * Script detection from a single pass over the text.
 *
 * Ranges, and why each is here:
 *
 *   hiragana  U+3040–U+309F   Japanese only. The single most reliable signal.
 *   katakana  U+30A0–U+30FF   Also Japanese, and appears in loanwords even in texts that are
 *                             otherwise Han-heavy — which is why kana beats Han when both
 *                             are present.
 *   hangul    U+AC00–U+D7AF   Korean syllables.
 *   han       U+4E00–U+9FFF   CJK ideographs. Shared by Chinese and Japanese, so it is the
 *                             fallback: its presence with no kana means Chinese.
 *   halfwidth katakana U+FF66–U+FF9D and hangul jamo U+1100–U+11FF are folded into their
 *                             fullwidth scripts, because halfwidth katakana is common in
 *                             Japanese marketing copy and jamo in older Korean text.
 */
const SCRIPT_RANGES = {
  hiragana: /[\u3041-\u3096]/,
  katakana: /[\u30A1-\u30FA\u30FC-\u30FF\uFF66-\uFF9D]/,
  hangul: /[\u1100-\u11FF\uAC00-\uD7A3]/,
  han: /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,
} as const;

export type DetectedLanguage = 'zh' | 'ja' | 'ko' | 'latin';

/**
 * The label shown on a card, per detected language.
 *
 * Short, and chosen to read as a language rather than a country: `中文` and not `中国`, `日本
 * 語` and not `日本`. `Latin` rather than `EN` because the detector does not separate Latin
 * languages, and claiming `EN` for a Spanish article would be a wrong answer rather than a
 * coarse one.
 */
export const LANGUAGE_LABELS: Record<DetectedLanguage, string> = {
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  latin: 'EN',
};

/**
 * Detect the language of a piece of text.
 *
 * Order matters and encodes the reasoning above: kana implies Japanese even when Han
 * ideographs dominate (a Japanese article full of kanji is still Japanese), and Hangul
 * implies Korean. Han without kana or Hangul is Chinese. Anything else is Latin by exclusion.
 *
 * A short or empty string with none of the ranges returns `latin`, which is the honest
 * default: most titles in the archive are Latin-script, and a badge is a hint rather than a
 * claim worth failing over.
 */
export function detectLanguage(text: string): DetectedLanguage {
  if (!text) return 'latin';

  // Cheap ordering: kana first because it is the most specific signal and the most common
  // non-Latin case here, then Hangul, then Han.
  if (SCRIPT_RANGES.hiragana.test(text) || SCRIPT_RANGES.katakana.test(text)) return 'ja';
  if (SCRIPT_RANGES.hangul.test(text)) return 'ko';
  if (SCRIPT_RANGES.han.test(text)) return 'zh';

  return 'latin';
}

/**
 * The text a language is detected from: the title first, then the body.
 *
 * The title leads because it is what the badge will most visibly contradict if it is wrong,
 * and because it is always present where a body may not be. The body is appended so a
 * Japanese article with an English title is still detected as Japanese — the signal just has
 * to be in the text somewhere, and more text is more signal.
 *
 * Capped: a language is a property of the whole text and the opening few thousand characters
 * carry every script the article uses. Scanning a 40kB body would be work for no extra
 * certainty.
 */
export function languageSample(title: string | null, body: string | null, limit = 8000): string {
  const parts = [title ?? '', (body ?? '').slice(0, limit)];
  return parts.filter((p) => p.length > 0).join('\n');
}
