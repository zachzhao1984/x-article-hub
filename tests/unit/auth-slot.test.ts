import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The account slot's script must have every key it looks up.
 *
 * ## The bug this pins
 *
 * The header script does `tr('accountMenuNamed')`, which indexes an injected object:
 * `authI18n[key]['data-i18n-en']`. `accountMenuNamed` was in the sibling `authText` object but
 * not in `authI18n`, so `tr` read a property of `undefined` and threw — and the `.catch` at the
 * end of the promise chain swallowed it silently, so a signed-in reader simply had no avatar
 * and nothing anywhere said why. The site looked fine; only a signed-in browser showed it.
 *
 * Two changes came out of it, and this file asserts both: the key is present, and the catch
 * reports rather than swallows.
 */

const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');

/** The keys of an injected object literal, by name. */
function injectedKeys(name: string): string[] {
  const start = header.indexOf(`${name}: {`);
  expect(start, `${name} is not injected at all`).toBeGreaterThan(-1);
  // Brace-match, because the values are themselves object literals.
  let depth = 0;
  let i = header.indexOf('{', start);
  const begin = i;
  for (; i < header.length; i += 1) {
    if (header[i] === '{') depth += 1;
    else if (header[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = header.slice(begin, i);
  return [...body.matchAll(/(?:^|[\s,{])(\w+):/g)].map((m) => m[1] ?? '').filter(Boolean);
}

describe('the account slot', () => {
  it('defines every key the script looks up in authI18n', () => {
    // The keys `tr(…)` is called with, read from the script rather than hard-coded, so a
    // future call site is covered without editing this list.
    const script = header.slice(header.indexOf('(function () {\n      var slot'));
    const looked = new Set([...script.matchAll(/\btr\('(\w+)'\)/g)].map((m) => m[1] ?? ''));
    const provided = new Set(injectedKeys('authI18n'));

    expect(looked.size, 'no tr() call sites found — the scan is vacuous').toBeGreaterThan(0);
    for (const key of looked) {
      expect(provided.has(key), `tr('${key}') is called but authI18n has no '${key}'`).toBe(true);
    }
  });

  it('has an i18n entry for every menu label it renders', () => {
    // `applyI18n(el, key)` indexes the same object, so a missing key breaks the menu item the
    // same silent way the avatar broke.
    const script = header.slice(header.indexOf('(function () {\n      var slot'));
    const applied = [...script.matchAll(/applyI18n\(\w+, '(\w+)'\)/g)].map((m) => m[1] ?? '');
    const provided = new Set(injectedKeys('authI18n'));
    expect(applied.length).toBeGreaterThan(0);
    for (const key of applied) {
      expect(provided.has(key), `applyI18n(…, '${key}') but authI18n has no '${key}'`).toBe(true);
    }
  });

  it('reports a failure instead of swallowing it', () => {
    // The silent catch is what made this invisible. A UI upgrade path that fails must say so.
    expect(header).toMatch(/\.catch\(function \(error\)/);
    expect(header).toMatch(/console\.warn\('\[auth-slot\]/);
    // And the empty catch that used to be here is gone.
    expect(header).not.toMatch(/\.catch\(function \(\) \{\s*\/\/ Offline/);
  });

  it('still degrades to the signed-out link', () => {
    // The failure must not leave the slot empty: the server renders a working link and the
    // script only replaces it on success.
    expect(header).toMatch(/<span class="auth-slot" data-auth-slot>/);
    expect(header).toMatch(/href="\/account"/);
  });
});
