import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('public/site.css'), 'utf8');
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declarations the stylesheet actually applies to a selector, per the browser.
 *
 * A hand-written CSS parser was tried first and was the wrong tool twice over: the
 * file nests at-rules, several selector lists wrap across lines, and `.article-body`
 * legitimately appears in two separate rules — one setting the family and size, a
 * later one restating the leading. Any of those defeats a regex over the source, and
 * the failure is silent: the assertion passes on a block that was never really read.
 *
 * So the static checks below are restricted to things a parser cannot be trusted to
 * resolve — the token definitions and the presence of a declaration at all. The
 * computed values, which are what a reader actually sees, are asserted in
 * `tests/fixtures` by rendering the page in a browser; see the sibling assertions
 * for the leading, which is the one property source order silently decided.
 */
function ruleDecls(...selectors: string[]): string {
  const wanted = new Set(selectors);
  const found: string[] = [];
  // Match a whole rule by requiring its selector list to end at the brace, which is
  // the one shape a single regex does get right.
  const re = /(?:^|\n)((?:[^{}\n]|\n(?![^{}]*\n))*?)\{([^}]*)\}/g;
  for (const match of clean.matchAll(re)) {
    const list = (match[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length !== wanted.size) continue;
    if (!list.every((s) => wanted.has(s))) continue;
    found.push(match[2] ?? '');
  }
  if (found.length === 0) throw new Error(`no rule with exactly [${selectors.join(', ')}]`);
  return found.join('\n');
}

/** Every rule whose selector list contains this selector, declarations joined. */
function ruleDeclsContaining(selector: string): string {
  const re = /(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g;
  const found: string[] = [];
  for (const match of clean.matchAll(re)) {
    const list = (match[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // A compound like `.article-body p` is one member; match it whole.
    if (list.some((s) => s === selector)) found.push(match[2] ?? '');
  }
  if (found.length === 0) throw new Error(`no rule names ${selector}`);
  return found.join('\n');
}

describe('typography', () => {
  const body = ruleDecls('body');

  it('sets the base size and leading from the brief', () => {
    // 16px / 1.75 is the brief's value, and it is right for a CJK archive: glyphs
    // fill the em box, so 15px is below the comfortable floor and 1.65 leaves
    // adjacent lines a couple of pixels from touching.
    expect(body).toMatch(/font:\s*400 16px\/1\.75 var\(--sans\)/);
    expect(body).toContain('text-rendering: optimizeLegibility');
  });

  it('leads the sans stack with the CJK families the brief names', () => {
    const sans = /--sans:\s*([^;]+);/.exec(clean)?.[1] ?? '';
    // Order is the point: `Inter` first because it has no CJK coverage, so it paints
    // Latin only and the CJK families take over per-character. A face that cannot
    // render a glyph is skipped, which is what lets one stack serve mixed text.
    expect(sans).toMatch(/^\s*"Helvetica Neue",/);
    for (const face of [
      'PingFang SC',
      'PingFang TC',
      'Microsoft YaHei',
      'Microsoft JhengHei',
      'Noto Sans CJK SC',
      'Noto Sans CJK TC',
      'Hiragino Sans GB',
    ]) {
      expect(sans, `sans stack is missing ${face}`).toContain(`"${face}"`);
    }
    // Every CJK face must precede the generic keyword, or a platform without them
    // falls straight through to whatever the OS decides.
    const generic = sans.indexOf('sans-serif');
    for (const face of ['"Noto Sans CJK SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"']) {
      expect(sans.indexOf(face), `${face} appears after the generic family`).toBeLessThan(generic);
    }
    // The serif stack needs CJK coverage too, even though only a digit uses it now:
    // `ui-serif` resolves Chinese to Songti, whose hairlines disappear on a light
    // ground.
    const serif = /--serif:\s*([^;]+);/.exec(clean)?.[1] ?? '';
    expect(serif).toMatch(/Songti SC|Noto Serif CJK/);
  });

  it('gives the reading surface the sans family, not a CJK serif', () => {
    // The legibility-critical decision in the file. `.article-body` declares itself
    // in two rules, so the check is over both: a family set in one and a leading in
    // the other is exactly the shape that hides a mistake.
    const decls = ruleDeclsContaining('.article-body');
    expect(decls).toMatch(/font-family:\s*var\(--sans\)/);
    expect(decls).not.toContain('var(--serif)');
  });

  it('restates the reading surface after the 1.5 fallback, not before it', () => {
    // The 1.5 block lists bare `p`, `ul`, `blockquote` and `h1`–`h6`, all of which
    // match the reading surface's own elements. They tie on specificity and the later
    // rule wins by source order, so where the restatement sits is the whole
    // mechanism. It went after the fallback once, and body text collapsed from 30.6px
    // to 26.25px — the exact leading it was raised to fix.
    const fallback = /@media|\.hero-sub[\s\S]*?line-height:\s*1\.5;/.exec(clean);
    expect(fallback, 'no 1.5 fallback block').not.toBeNull();

    const fallbackAt = clean.indexOf('.hero-sub, .board-title');
    const restatedAt = clean.indexOf('.article-body,\n.article-body p');
    expect(fallbackAt, 'cannot locate the 1.5 fallback list').toBeGreaterThan(0);
    expect(restatedAt, 'cannot locate the reading-surface restatement').toBeGreaterThan(fallbackAt);

    // Every element type the reading surface uses has to be named, or one of them
    // falls back to 1.5 while its siblings keep 1.75.
    const restated = clean.slice(restatedAt, clean.indexOf('}', restatedAt));
    for (const child of ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote']) {
      expect(restated, `.article-body ${child} is not covered`).toContain(`.article-body ${child}`);
    }
    // A code block is not prose and keeps the tighter leading.
    expect(restated).not.toContain('.article-body pre');
  });

  it('drops the negative tracking that CJK headlines cannot take', () => {
    // -0.03em is tuned for Latin counters. CJK glyphs already fill the em box, so
    // tracking them in squeezes the ideographs together and reads as a fault.
    const title = ruleDecls('.article-title');
    expect(title).toMatch(/font-family:\s*var\(--sans\)/);
    expect(title).toMatch(/letter-spacing:\s*0/);
    expect(/letter-spacing:\s*-\d/.test(title)).toBe(false);
  });

  it('uses the sans family for every CJK-dominant heading', () => {
    // A Latin serif leading the stack means the Latin runs in Georgia while the CJK
    // falls to Songti, so one headline mixes two designs sitting on two baselines.
    for (const selector of ['.hero-sub', '.card-title', '.empty-state h2', '.prose h1']) {
      expect(ruleDecls(selector), `${selector} still uses the serif family`).toMatch(
        /font-family:\s*var\(--sans\)/,
      );
    }
  });

  it('keeps a serif only where the text is Latin-only', () => {
    // The ranking number is the one deliberate serif left; it is a digit, so there is
    // no CJK to clash with.
    const serifUsers = [...clean.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
      .filter((m) => /var\(--serif\)/.test(m[2] ?? ''))
      .map((m) => (m[1] ?? '').trim());
    expect(serifUsers).toEqual(['.rank']);
  });

  it('leaves no small label inheriting the prose leading', () => {
    // 1.75 cascading to an 11–13px label put it in a 21px line box, which showed as a
    // visible gap between a card title and its author. Checked per rule, over every
    // one that sets a sub-16px size and declares no leading of its own.
    const fallback = /(\.hero-sub,[\s\S]*?)\{/.exec(clean);
    expect(fallback, 'cannot locate the 1.5 fallback list').not.toBeNull();
    const covered = new Set((fallback?.[1] ?? '').split(',').map((s) => s.trim()));
    const bareElement = /^(p|ul|ol|blockquote|pre|h[1-6])$/;

    const offenders: string[] = [];
    for (const match of clean.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)) {
      const selectors = (match[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const declarations = match[2] ?? '';
      const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(declarations)?.[1];
      if (!size || Number(size) >= 16) continue;
      if (/line-height:/.test(declarations) || /font:/.test(declarations)) continue;
      if (selectors.some((s) => covered.has(s) || bareElement.test(s))) continue;
      if (selectors.some((s) => s.startsWith('--'))) continue;
      // A media query's prelude is a sibling of the selector in this regex's view, and
      // a responsive override inside it is a different rule from the base one it
      // refines — the base rule already carries its own leading or is in the list.
      if (selectors.some((s) => s.startsWith('@media'))) continue;
      offenders.push(`${selectors.join(', ').slice(0, 44)} (${size}px)`);
    }
    expect(offenders, 'small text inheriting the prose leading').toEqual([]);
  });

  it('never reads a custom property this stylesheet does not define', () => {
    // The whole point of a token is that a name means one thing. site.css and admin.css
    // are separate bundles that happen to share some names: admin.css defines
    // `--accent-ink` where site.css defines `--accent-contrast`. Writing the admin name
    // here compiles, deploys, and passes every other check in this file — the var() simply
    // has nothing to resolve to, so the declaration is invalid at computed-value time and
    // the property falls back to its inherited value.
    //
    // On `.btn-primary` that meant near-black `--text` lettering sitting on the accent
    // fill: **2.37:1**, which fails WCAG AA even for bold text, while the active nav item
    // next to it was 6.18:1 on the same fill. It read as a styling choice because both
    // colours are plausible; nothing about the rule said a token was missing.
    //
    // So this is asserted over the whole sheet rather than on the one rule, because the
    // failure is not specific to buttons — a mistyped token in any future rule is the same
    // bug, and it fails silently every time.
    const defined = new Set(
      [...clean.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]?.toLowerCase() ?? ''),
    );
    // Shiki supplies these properties in the generated HTML's inline styles.
    defined.add('--shiki-dark');
    defined.add('--shiki-dark-bg');
    expect(defined.size, 'found no custom properties at all — is this reading the right file?').toBeGreaterThan(10);

    const used = new Map<string, string>();
    for (const match of clean.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = match[1]?.toLowerCase() ?? '';
      if (!used.has(name)) used.set(name, '');
      // Remember the selector the first use appeared under, so a failure names a place.
      const before = clean.slice(0, match.index ?? 0);
      const rule = before.lastIndexOf('{');
      const selectorStart = before.lastIndexOf('}', rule);
      used.set(name, before.slice(selectorStart + 1, rule).trim().split('\n').pop() ?? '?');
    }

    const unresolved = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, selector]) => `${name} (in ${selector})`);

    expect(unresolved, 'var() names this stylesheet never defines').toEqual([]);
  });

  it('loads no webfont, so the stack costs nothing when the face is absent', () => {
    // Inter is a local-name lookup. A CDN font would add a blocking request and
    // render-invisible text on the article surface, which is the wrong trade for a
    // CJK archive where the CJK faces are the primary rendering anyway.
    expect(clean).not.toMatch(/@font-face/);
    expect(clean).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});
