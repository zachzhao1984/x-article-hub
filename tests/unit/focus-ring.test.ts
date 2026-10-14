import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One focus standard across both bundles.
 *
 * There used to be three. Public inputs and selects ran `outline: none` and shifted the
 * border to `--accent-dim`, which is a colour change close to invisible for anyone who
 * cannot separate that hue from the hairline it borders. The public switches drew a
 * 2px accent ring at +1px. The admin drew the same ring at -1px, but only on text
 * fields, so tabbing through the admin met the browser default on everything else.
 *
 * Two of the three were right, and the one that was wrong was the one on the elements a
 * reader types into. These tests exist so it cannot quietly become three again.
 */
const site = readFileSync(resolve('public/site.css'), 'utf8');
const admin = readFileSync(resolve('public/admin.css'), 'utf8');

/**
 * Comments removed, for the negative assertions.
 *
 * `outline: none` does not appear anywhere in either stylesheet now — which means the
 * only place that string can match is the note in site.css explaining that inputs used
 * to suppress it. Stripping first keeps the assertions about the code.
 *
 * `--` goes too: these files carry real CSS custom properties, and an assertion looking
 * for a two-character dash would otherwise be reading token declarations.
 */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const siteCode = code(site);
const adminCode = code(admin);

/**
 * The one selector every focusable element is supposed to match.
 *
 * Matched against the raw source, not `code()` — the stripper above deletes from `--` to
 * the end of the line, and `var(--accent)` is exactly the string these assertions need.
 * Positive assertions are safe against raw source: a comment repeating a value can only
 * make them pass, never falsely fail.
 */
const FOCUS_RULE = /:where\([^)]*\):focus-visible\s*\{/g;
const ringOf = (css: string) => css.match(/:where\([^)]*\):focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';

describe('SPEC — one focus standard, public and admin', () => {
  it('declares the rule once per bundle', () => {
    expect(site.match(FOCUS_RULE)).toHaveLength(1);
    expect(admin.match(FOCUS_RULE)).toHaveLength(1);
  });

  it('uses an identical ring in both bundles', () => {
    for (const css of [site, admin]) {
      const rule = ringOf(css);
      expect(rule).toContain('outline: 2px solid var(--accent)');
      expect(rule).toContain('outline-offset: -1px');
    }
  });

  it('covers every element that takes keyboard focus', () => {
    for (const css of [site, admin]) {
      const selector = css.match(/:where\(([^)]*)\):focus-visible/)?.[1] ?? '';
      for (const target of ['a', 'button', 'input', 'select', 'textarea', 'summary', '[tabindex]']) {
        expect(selector).toContain(target);
      }
    }
  });

  it('suppresses the outline nowhere', () => {
    expect(siteCode).not.toMatch(/outline:\s*(none|0)\b/);
    expect(adminCode).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it('draws every ring inset, so no ancestor can clip it', () => {
    /**
     * `.card-article` is `overflow: hidden` because that is what clips its cover image to
     * the card's radius. An outset ring around the card's title link is cut off on both
     * sides and reads as a pair of brackets. Any new `outline-offset` has to be inset too.
     */
    for (const css of [site, admin]) {
      for (const match of css.matchAll(/outline-offset:\s*(-?[\d.]+px)/g)) {
        expect(match[1]).toBe('-1px');
      }
    }
  });

  it('leaves the radius to the element, so a round control keeps a round ring', () => {
    /**
     * An outline already follows its element's own border-radius. Declaring one here would
     * give a 7px input a 3px ring and a square link a round one — the opposite of both.
     */
    for (const css of [site, admin]) {
      expect(ringOf(css)).not.toContain('border-radius');
    }
  });

  it('keeps the border shift as a second cue, not a substitute', () => {
    /**
     * The input rules still darken their border on focus, which is a useful extra signal
     * for a reader already looking at the field. What they must not do is trade the ring
     * back for it — that was the original defect.
     *
     * The category filter's shift lives on `:focus-within` of its wrapper rather than on
     * the select, because the wrapper is what carries the chevron and the active state;
     * the cue it produces is the same border change.
     */
    const shifted = [
      '.search-mini input:focus',
      '.search-form input:focus',
      '.category-filter:focus-within .category-select',
    ];
    for (const selector of shifted) {
      const rule = site.match(new RegExp(`${selector.replace(/[.:[\]-]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, `no rule matched ${selector}`).toContain('border-color');
      expect(rule).not.toContain('outline');
    }
  });

  it('redirects the ring onto the visible option for the hidden-radio switches', () => {
    /**
     * The focusable element in both switches is a visually-hidden input, so the global
     * ring lands on it and nobody sees it. These rules are structural, not a second
     * standard — which is why their offset still has to match the global one.
     */
    for (const selector of ['.theme-switch__option:has(input:focus-visible)', '.lang-switch__option:focus-visible']) {
      const rule = site.match(new RegExp(`${selector.replace(/[.:[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule).toContain('outline: 2px solid var(--accent)');
      expect(rule).toContain('outline-offset: -1px');
    }
  });
});
