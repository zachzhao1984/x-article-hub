import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The nav's three states.
 *
 * The active state used to be `background: var(--panel-2)`, which on the header is a
 * contrast ratio of **1.06** in the light theme and **1.21** in the dark one. That is not
 * "subtle"; it is indistinguishable from the idle state at any viewing distance, which is
 * what a reader reported. The replacement is the theme switch's own selected state, so the
 * accent means one thing on this site: you are here.
 *
 * Every assertion below is paired with the number that made it worth making, because the
 * failure this file exists for is not a typo — it is a token that looks right in a
 * stylesheet and measures as invisible on a header.
 */

const css = readFileSync(resolve('public/site.css'), 'utf8');

/**
 * The declaration block of the rule whose selector list contains `selector`.
 *
 * Scans every rule rather than pattern-matching one, because the rules that matter here are
 * comma lists: the active state is written as `.nav-item.active, .nav-item.active:hover`, and
 * a regex anchored on `\.nav-item\.active\s*\{` misses it because a comma comes next. It
 * missed it in the first version of this file, and six assertions failed with "no rule".
 */
function selectorsFor(selector: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return selectors;
  }
  throw new Error(`no rule for ${selector}`);
}

/** The declarations of the rule whose selector list contains `selector`. */
function ruleFor(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  throw new Error(`no rule for ${selector}`);
}

/**
 * `#rgb` or `#rrggbb` → relative luminance.
 *
 * The three-digit form is not hypothetical: `--accent-contrast` is `#fff` in the light
 * theme, and the first version of this read it as `#ff`, `0xf`, and an empty slice — which
 * is `NaN`, so the contrast assertion passed a number that was not a number and failed
 * with "expected NaN to be greater than or equal to 4.5".
 */
function luminance(hex: string): number {
  let value = hex.replace('#', '');
  if (value.length === 3) value = [...value].map((c) => c + c).join('');
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The token values of both themes, lifted out of site.css so the numbers are the real ones. */
function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block =
    theme === 'light'
      ? /(?:^|\n):root\s*\{([^}]*)\}/.exec(clean)?.[1]
      : /(?:^|\n):root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(clean)?.[1];
  if (!block) throw new Error(`no ${theme} token block`);
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1]!, m[2]!]),
  );
}

describe('the nav current state', () => {
  it('is the theme switch\'s own selected treatment', () => {
    // One accent-coloured current item in a row of quiet ones. Copied rather than invented
    // so the accent carries a single meaning across the site.
    const active = ruleFor('.nav-item.active');
    expect(active).toContain('background: var(--accent)');
    expect(active).toContain('color: var(--accent-contrast)');

    const switcher = ruleFor('.theme-switch__option:has(input:checked)');
    expect(switcher).toContain('background: var(--accent)');
    expect(switcher).toContain('color: var(--accent-contrast)');
  });

  it('separates the current page from the header by a measurable margin', () => {
    // The number that replaced 1.06. Both themes, so neither can be quietly dropped.
    for (const theme of ['light', 'dark'] as const) {
      const t = tokens(theme);
      const ratio = contrast(t['--accent']!, t['--bg']!);
      expect(ratio, `${theme}: the accent fill against the header`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('separates its own lettering from its own fill', () => {
    // A loud fill with unreadable text inside would be worse than the invisible state it
    // replaced, and it would not look wrong in a screenshot.
    for (const theme of ['light', 'dark'] as const) {
      const t = tokens(theme);
      expect(
        contrast(t['--accent']!, t['--accent-contrast']!),
        `${theme}: lettering on the accent fill`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is not the invisible state any more', () => {
    // Asserted as an absence, because this is the specific regression: a future edit that
    // "harmonises" the active fill back to a panel token would pass every other test here.
    const active = ruleFor('.nav-item.active');
    for (const token of ['--panel-2', '--panel', '--border', '--border-soft']) {
      expect(active, `the active fill is back on ${token}`).not.toContain(token);
    }
  });

  it('survives a hover, which the old pairing silently undid', () => {
    // The hover rule sets a background, so without the active state repeating itself the
    // current page would lose its fill the moment a pointer crossed it — the same class of
    // fault as the theme switch that persisted a choice and repainted nothing.
    // Looked up by the single selector and then inspected as a list, because the point is
    // which selectors *share* the rule — a test that passed the whole comma list as one
    // selector could not ask that.
    expect(selectorsFor('.nav-item.active'), 'the active rule does not cover :hover').toContain(
      '.nav-item.active:hover',
    );
    expect(ruleFor('.nav-item.active')).toContain('background: var(--accent)');
    expect(ruleFor('.nav-item:hover')).not.toContain('var(--accent)');
  });

  it('does not spend the nav\'s horizontal slack on a bolder current label', () => {
    // `cat-chip.active` sets `font-weight: 600` and can afford it; the nav cannot. Measured:
    // seven items at 10px padding need exactly the 642px the row has from 1200px up, so a
    // wider current item would clip the last one — and only on the pages where it is bold,
    // making the row change width on every navigation.
    expect(ruleFor('.nav-item.active')).not.toContain('font-weight');
  });

  it('leaves hover neutral, so accent keeps meaning selected', () => {
    // A tinted hover would compete with the accent for one meaning. The lettering is what
    // carries it: --muted is 5.7:1 on the header and --text is 13.9:1.
    const hover = ruleFor('.nav-item:hover');
    expect(hover).toContain('color: var(--text)');
    expect(hover).not.toContain('--accent');
  });

  it('never puts two different current treatments in one header', () => {
    // The nav has no `/category/*` entry and `isActive` matches on a path prefix, so a
    // category page activates no nav item and a board page activates no chip. The
    // `.cat-chip.active` text fill and the `.nav-item.active` accent fill are therefore never
    // on screen together. Asserted so that adding a category entry to the nav — which would
    // put a near-black pill 60px below an accent one — breaks a test instead of a reviewer's
    // eye.
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    const navHrefs = [...header.matchAll(/href: '([^']+)'/g)].map((m) => m[1] ?? '');
    expect(navHrefs.some((href) => href.startsWith('/category'))).toBe(false);
    expect(navHrefs).not.toContain('/category/:slug');

    // And the two rules are genuinely different, which is what makes the non-co-occurrence
    // load-bearing rather than a coincidence.
    expect(ruleFor('.cat-chip.active')).toContain('background: var(--text)');
    expect(ruleFor('.nav-item.active')).toContain('background: var(--accent)');
  });
});