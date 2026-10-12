import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * `define:vars` is evaluated on the server while the page renders.
 *
 * ## The bug this pins
 *
 * `define:vars={{ lang: (function () { return document.cookie… })() }}` on the article page
 * put a browser-only global in an expression the server evaluates. Every article page returned
 * a 500 with an empty body, and *only* article pages: the homepage and every list page kept
 * working, so the site looked healthy from the front door — the same shape as the header bug
 * earlier, where the `<head>` rendered and the body stopped.
 *
 * The rule is narrow and worth stating: the object passed to `define:vars` must be
 * serialisable data. Anything read from `document`, `window` or `localStorage` has to move
 * inside the script body, which runs in the browser after serialisation.
 *
 * Astro does not typecheck `.astro` files here (`tsc` skips them and `astro check` is not
 * installed), so nothing else catches this before it reaches production.
 */

/** Every `.astro` file under src. */
function astroFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return astroFiles(full);
    return entry.endsWith('.astro') ? [full] : [];
  });
}

/** The contents of every `define:vars={{ … }}` block in a file. */
function defineVarsBlocks(source: string): string[] {
  const blocks: string[] = [];
  let search = 0;
  for (;;) {
    const start = source.indexOf('define:vars={{', search);
    if (start === -1) break;
    // Walk the braces to find the matching close, rather than a lazy regex that would stop at
    // the first `}}` inside a nested object literal.
    let depth = 0;
    let i = source.indexOf('{{', start) + 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(start, i + 1));
    search = i + 1;
  }
  return blocks;
}

describe('define:vars carries data, not browser expressions', () => {
  const files = astroFiles(resolve('src'));

  it('has at least one define:vars to check, so the scan is not vacuous', () => {
    const total = files.reduce((n, f) => n + defineVarsBlocks(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('never reads a browser global inside the block', () => {
    // `document`, `window` and `localStorage` do not exist while the server renders the page.
    const browserGlobals = /\b(document|window|localStorage|sessionStorage|navigator)\b/;
    for (const file of files) {
      for (const block of defineVarsBlocks(readFileSync(file, 'utf8'))) {
        const hit = browserGlobals.exec(block);
        expect(
          hit,
          `${file.replace(resolve('.'), '.')} reads \`${hit?.[1]}\` inside define:vars, which the server evaluates: ${block.slice(0, 120)}…`,
        ).toBeNull();
      }
    }
  });

  it('reads the language cookie in the script body, not in define:vars', () => {
    // The specific line that caused the 500, kept as a named case so a future edit that
    // reintroduces it says what it broke.
    const page = readFileSync(resolve('src/pages/article/[slug].astro'), 'utf8');
    expect(page).toMatch(/document\.cookie/);
    for (const block of defineVarsBlocks(page)) {
      expect(block).not.toMatch(/document\.cookie/);
    }
  });
});
