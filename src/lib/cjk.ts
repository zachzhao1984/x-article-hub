/**
 * CJK segmentation for the FTS index.
 *
 * Why this exists: `articles_fts` is tokenised with SQLite's `unicode61`, which
 * classifies a CJK ideograph as an alphanumeric character. So a run of Chinese with
 * no whitespace between it is indexed as **one token** — the body of the archived
 * 美股 article contains tokens like `一篇讲清楚美股入门的基本逻辑`, and a reader searching
 * for `投资` gets nothing back even though the word is right there. The archive is
 * mostly Chinese, so that made search useless for the language most of its content is
 * in, while every Latin query kept working — which is why it went unnoticed: the
 * acceptance check searches for `cache`.
 *
 * The fix is to put a separator either side of every CJK character *before* indexing.
 * `unicode61` then splits on the spaces and each ideograph becomes its own token,
 * while Latin words are untouched because they have no separator inserted next to
 * them. Nothing else about the index changes: same tokenizer, same triggers, same
 * table.
 *
 * Plain spaces rather than a zero-width character, which `unicode61` also accepts.
 * A zero-width separator would round-trip through `snippet()` invisibly and so would
 * need no cleanup, but it would leave an invisible character between every ideograph
 * of every stored body — unreadable in a `SELECT`, hostile to a future `LIKE`
 * fallback, and surprising in a CSV export. `deSegment` removes that trade for one
 * line of cleanup on the preview only.
 */

/**
 * The ranges worth segmenting.
 *
 * Kana and Hangul are here for the same reason as the ideographs: `unicode61` treats
 * all of them as alphanumeric, so Japanese and Korean text breaks exactly the same
 * way. Not included: fullwidth forms (U+FF00–FFEF), where splitting a run of
 * fullwidth Latin would be a change with no benefit, and the compatibility
 * ideographs, which are not text anyone writes.
 *
 * Built as a character class rather than a code-point test because this runs on the
 * full body of every article — `test()` per character on a 9kB body is the kind of
 * thing that turns a 40ms parse into a 400ms one.
 */
const CJK = '\\u2E80-\\u2FFF\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF';

/** True when the string contains anything this module would segment. */
export function hasCjk(text: string): boolean {
  return new RegExp(`[${CJK}]`, 'u').test(text);
}

/**
 * The indexed form of a piece of text.
 *
 * Latin is left exactly as it was, so an English-only article indexes byte-identically
 * to today. Surrounding whitespace is trimmed because a leading or trailing separator
 * would otherwise produce an empty token at the edge of the string.
 */
export function segmentCjk(text: string): string {
  if (!hasCjk(text)) return text;
  return text
    .replace(new RegExp(`([${CJK}])`, 'gu'), ' $1 ')
    // Collapse before trimming, so an ideograph that already sat next to a space does
    // not leave two behind — which would split into an empty token.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** True when a single character is one this module would segment. */
function isCjk(char: string): boolean {
  return char !== '' && new RegExp(`[${CJK}]`, 'u').test(char);
}

/**
 * The inverse, for text that came back out of the index.
 *
 * Only used on `snippet()` output. It removes a run of spaces when a CJK character
 * sits on either side, which is every space `segmentCjk` inserted and also — this is
 * the honest limitation — any space the author genuinely put between a Chinese
 * character and an adjacent Latin word. `美股 ETF` previews as `美股ETF`. The cost is
 * a missing space in a preview; the alternative is an index nothing can read.
 *
 * Scanned one space at a time rather than with two lookaround patterns, because
 * `snippet()` wraps the matched phrase in `<mark>` and a space whose neighbours are a
 * CJK character and a tag would slip past a pattern that only inspects characters. On
 * `美 <mark>投 资</mark> 股` the tag is stepped over and all three spaces go, leaving
 * `美<mark>投资</mark>股`.
 */
export function deSegment(text: string): string {
  if (!text.includes(' ')) return text;

  return text.replace(/[ \t]+/g, (space, offset: number, whole: string) => {
    const before = whole.slice(0, offset).replace(/<\/?mark>$/, '');
    const after = whole.slice(offset + space.length).replace(/^(<\/?mark>)/, '');
    return isCjk(before.slice(-1)) || isCjk(after[0] ?? '') ? '' : space;
  });
}