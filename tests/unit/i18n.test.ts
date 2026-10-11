import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SITE_LANGS,
  DEFAULT_LANG,
  LANG_COOKIE,
  TRANSLATIONS,
  i18nSpread,
  i18nAttrSpread,
} from '../../src/lib/i18n';

/**
 * SPEC §17.4 — public-site internationalization.
 *
 * The mechanism is the load-bearing part, so most of this file is about it rather than about
 * any particular translation:
 *
 *  - the catalog is *complete*. A key present in one language and missing in another is a
 *    reader seeing a blank where a word should be, and the type system cannot catch it
 *    because the catalog is built as three objects assigned the same interface — a missing
 *    key is a compile error, but an *empty string* is not.
 *  - the server renders the default language and the client swaps, because the pages are
 *    edge-cached without varying on cookies. A page that rendered the reader's language
 *    server-side would be cached and served to everyone.
 *  - the script runs before first paint, for the same reason the theme script does.
 */

const i18nSrc = readFileSync(resolve('src/lib/i18n.ts'), 'utf8');
const baseSrc = readFileSync(resolve('src/layouts/Base.astro'), 'utf8');

/** Every public page and component that renders reader-facing text. */
const PUBLIC_SURFACES = [
  'src/components/SiteHeader.astro',
  'src/components/ArticleCard.astro',
  'src/components/BoardPage.astro',
  'src/components/LangSwitch.astro',
  'src/pages/index.astro',
  'src/pages/latest.astro',
  'src/pages/trending.astro',
  'src/pages/featured.astro',
  'src/pages/about.astro',
  'src/pages/search.astro',
  'src/pages/account.astro',
  'src/pages/authors.astro',
  'src/pages/saved.astro',
  'src/pages/404.astro',
  'src/pages/article/[slug].astro',
  'src/pages/category/[slug].astro',
  'src/pages/tag/[slug].astro',
  'src/pages/author/[username].astro',
];

/** Source with comments stripped, so an assertion is about strings and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the catalog', () => {
  it('has every key in every language, and no empty strings', () => {
    // A missing key is a compile error, but an empty string is not — and an empty string is
    // what a reader actually sees, as a gap where a word should be.
    const keys = Object.keys(TRANSLATIONS.en) as Array<keyof typeof TRANSLATIONS.en>;
    expect(keys.length).toBeGreaterThan(150);
    for (const lang of SITE_LANGS) {
      for (const key of keys) {
        const value = TRANSLATIONS[lang][key];
        expect(value, `${lang}.${key} is missing`).toBeTruthy();
        expect(value.trim(), `${lang}.${key} is blank`).not.toBe('');
      }
    }
  });

  it('does not simply leave the translations in English', () => {
    // The failure this catches is a catalog where the Chinese object is a copy of the
    // English one: every key present, every test above passing, and nothing translated.
    const keys = Object.keys(TRANSLATIONS.en) as Array<keyof typeof TRANSLATIONS.en>;
    const untranslated = keys.filter(
      (k) => TRANSLATIONS.zh[k] === TRANSLATIONS.en[k] && TRANSLATIONS.ja[k] === TRANSLATIONS.en[k],
    );
    // A handful of identical values are correct — `RSS`, `中文`, product names — but the bulk
    // being identical means the translation did not happen. The ratio is asserted as well as
    // the count, so the guard does not weaken as the catalog grows.
    expect(untranslated.length, `identical in all three: ${untranslated.join(', ')}`).toBeLessThan(12);
    expect(untranslated.length / keys.length).toBeLessThan(0.06);
  });

  it('translates the interface labels a reader navigates by', () => {
    // A spot-check with real teeth: these are the words a reader who chose Chinese or
    // Japanese will see first, and each must actually differ from English.
    for (const key of ['nav.home', 'nav.trending', 'header.search.placeholder', 'board.older'] as const) {
      expect(TRANSLATIONS.zh[key], `zh.${key} is not translated`).not.toBe(TRANSLATIONS.en[key]);
      expect(TRANSLATIONS.ja[key], `ja.${key} is not translated`).not.toBe(TRANSLATIONS.en[key]);
    }
  });

  it('defaults to English, which is what the server renders', () => {
    // The pages are edge-cached without varying on cookies, so the server can only render one
    // language; everything else is applied client-side.
    expect(DEFAULT_LANG).toBe('en');
    expect(SITE_LANGS).toContain(DEFAULT_LANG);
  });
});

describe('i18nSpread', () => {
  it('carries every language, so the client never has to fetch one', () => {
    const attrs = i18nSpread('nav.home');
    expect(attrs['data-i18n-key']).toBe('nav.home');
    expect(attrs['data-i18n-en']).toBe(TRANSLATIONS.en['nav.home']);
    expect(attrs['data-i18n-zh']).toBe(TRANSLATIONS.zh['nav.home']);
    expect(attrs['data-i18n-ja']).toBe(TRANSLATIONS.ja['nav.home']);
  });

  it('passes values as separate attributes rather than baking them in', () => {
    // The substitution has to happen after the language is chosen, so the value cannot be
    // frozen into the stored string — that would need one rendered string per language per
    // value, which is the combinatorics this avoids.
    const attrs = i18nSpread('board.page', { page: 3 });
    expect(attrs['data-i18n-v']).toBe('page');
    expect(attrs['data-i18n-v-page']).toBe('3');
    expect(attrs['data-i18n-en']).toContain('{page}');
  });

  it('translates an attribute without touching the element text', () => {
    // A metric tooltip is the `title` of a list item that also holds an icon and a number;
    // setting textContent there would delete both.
    const attrs = i18nAttrSpread('title', 'card.views');
    expect(attrs['data-i18n-attr-title-key']).toBe('card.views');
    expect(attrs['data-i18n-attr-title-zh']).toBe(TRANSLATIONS.zh['card.views']);
    expect(attrs['data-i18n-key']).toBeUndefined();
  });
});

describe('the client script', () => {
  it('is injected inline, so it runs before first paint', () => {
    // Same requirement as the theme script: a deferred or bundled script would show English
    // and then swap, which is the flash the whole mechanism exists to avoid.
    expect(baseSrc).toMatch(/<script is:inline set:html=\{LANG_SCRIPT\} \/>/);
    expect(i18nSrc).toMatch(/export const LANG_SCRIPT = `/);
  });

  it('applies the stored language on load and on every click', () => {
    // The failure this guards is the one the theme switch actually had: a control that
    // persists a choice and repaints nothing.
    const script = i18nSrc.slice(i18nSrc.indexOf('export const LANG_SCRIPT'));
    expect(script).toMatch(/apply\(lang\)/);
    expect(script).toMatch(/document\.cookie = COOKIE/);
    // And applying is called from the click handler too, not only on load.
    const clickHandler = script.slice(script.indexOf("addEventListener('click'"));
    expect(clickHandler).toMatch(/apply\(chosen\)/);
  });

  it('validates the cookie rather than trusting it', () => {
    // The cookie is client-controlled; anything that is not a known language must fall back
    // rather than reach the DOM.
    const script = i18nSrc.slice(i18nSrc.indexOf('export const LANG_SCRIPT'));
    expect(script).toMatch(/LANGS\.indexOf\(stored\) >= 0 \? stored : DEFAULT/);
  });

  it('corrects <html lang>, because the served document is always the default', () => {
    // The document is cached and served as `lang="en"`; a page showing Japanese with
    // `lang="en"` is wrong for a screen reader.
    const script = i18nSrc.slice(i18nSrc.indexOf('export const LANG_SCRIPT'));
    expect(script).toMatch(/setAttribute\('lang'/);
  });

  it('reads the same cookie name the switcher writes and the header reads', () => {
    expect(LANG_COOKIE).toBe('xah_lang');
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    expect(header).toMatch(/Astro\.cookies\.get\(LANG_COOKIE\)/);
  });
});

describe('the switcher', () => {
  const switcher = readFileSync(resolve('src/components/LangSwitch.astro'), 'utf8');

  it('offers every language as a button, not a link', () => {
    // There is no URL per language — the choice lives in a cookie — so an anchor that does
    // not navigate would be a lie to a screen reader and break middle-click.
    expect(switcher).toMatch(/SITE_LANGS/);
    expect(switcher).toMatch(/<button/);
    expect(switcher).not.toMatch(/<a\s/);
    expect(switcher).toMatch(/data-lang-option/);
  });

  it('is in the header', () => {
    const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
    expect(header).toMatch(/import LangSwitch from '\.\/LangSwitch\.astro'/);
    expect(header).toMatch(/<LangSwitch/);
  });
});

describe('the public surfaces are wired', () => {
  it('every page and component uses the catalog', () => {
    // A page that renders English literals is invisible to the switcher: it would keep
    // showing English while everything around it changed language.
    for (const file of PUBLIC_SURFACES) {
      // `LangSwitch` is the exception by design: its labels are each language's name *in
      // that language* (`English`, `中文`, `日本語`), which is the same in every locale and so
      // is not in the catalog at all.
      if (file.endsWith('LangSwitch.astro')) continue;
      const src = readFileSync(resolve(file), 'utf8');
      expect(
        /i18nSpread|i18nAttrSpread/.test(src),
        `${file} does not use the i18n catalog`,
      ).toBe(true);
    }
  });

  it('does not translate the admin', () => {
    // SPEC §17.4 scopes this to the public site: the admin is a single-operator tool and its
    // strings are not translated.
    const adminUi = readFileSync(resolve('src/routes/admin-ui.ts'), 'utf8');
    expect(adminUi).not.toMatch(/i18nSpread|LANG_SCRIPT/);
  });
});
