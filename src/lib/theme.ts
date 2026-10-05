/**
 * SPEC §33 — the colour theme, as the two inline scripts and the option list that every
 * surface shares.
 *
 * These were inline in `Base.astro` alone, which was correct while `/admin` had no
 * switcher. It has one now, and the admin is server-rendered from `routes/views.ts`
 * rather than through an Astro layout, so "copy the script over" was the alternative. A
 * second copy of seventy lines of theme logic on a second surface is exactly the drift
 * `tests/unit/theme.test.ts` was written to prevent — it has a test named "exposes one
 * apply function rather than two implementations", and the failure it describes, the
 * handler that persisted a choice and repainted nothing, was a real bug.
 *
 * So the scripts are exported as strings and injected by both surfaces rather than
 * written twice. They stay plain ES5 in a string, not a module, for the reason they
 * were inline to begin with: a synchronous script in `<head>` is the only way to have
 * `data-theme` on `<html>` before the first paint, and a module or a deferred script
 * both arrive after it.
 */
import type { IconName } from '../icons/phosphor';

export type ThemeChoice = 'light' | 'dark' | 'system';

/**
 * localStorage key, and the cookie name.
 *
 * Both surfaces read and write the same pair, which is the whole point: the choice made
 * on the public site has to be the choice the admin honours, and the cookie is scoped
 * to `path=/` so it crosses between them without either surface knowing the other exists.
 */
export const THEME_STORAGE_KEY = 'xah-theme';
export const THEME_COOKIE = 'xah_theme';

/**
 * The three choices, each with a Phosphor glyph from the same set the navigation uses.
 *
 * `sun` and `moon` name the appearance directly; `desktop` is the machine that holds the
 * preference, which is what "follow the system" means. Kept here rather than in
 * `ThemeSwitch.astro` so the admin's copy of the control is generated from the same
 * list — two lists would eventually disagree about what the third option is called.
 */
export const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'Match system', icon: 'desktop' },
];

/**
 * The script that has to run before the first paint.
 *
 * Writes the literal choice — including `system` — to `data-theme`, so the stylesheet's
 * `:root:not([data-theme='light'])` and `[data-theme='dark']` rules keep deciding the
 * repaint. Every step is wrapped: a storage-denied browser (Safari in private mode) must
 * fall back to the system preference, not to a blank page.
 */
export const THEME_HEAD_SCRIPT = `(function () {
  var STORAGE_KEY = '${THEME_STORAGE_KEY}';
  var root = document.documentElement;
  var VALID = ['light', 'dark', 'system'];
  var BAR = { dark: '#13191c', light: '#faf9f6' };
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /**
   * Paints a choice. Exposed as \`window.__xahTheme\` so the change handler
   * below reuses it instead of reimplementing the attribute write, the
   * theme-color tag and the media listener — the two call sites drifting is
   * how clicking stopped repainting the page in the first place.
   *
   * The attribute always holds the literal choice, including \`system\`, so
   * the stylesheet's \`:root:not([data-theme='light'])\` and
   * \`[data-theme='dark']\` rules keep applying. Only the theme-color tag needs
   * the OS resolved down to a concrete colour.
   */
  function apply(choice) {
    if (VALID.indexOf(choice) === -1) return;
    root.setAttribute('data-theme', choice);

    var resolved = choice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : choice;

    // The media-scoped <meta name="theme-color"> tags cannot express a stored
    // choice, so an unscoped one is added. Mobile Safari reads that one.
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', BAR[resolved]);

    // Follow the OS, but only while the reader has not chosen otherwise.
    // Attaching this unconditionally would let the OS override an explicit
    // pick the moment the machine switched appearance.
    if (choice === 'system') {
      if (typeof darkQuery.addEventListener === 'function') {
        darkQuery.addEventListener('change', onSystemChange);
      } else if (typeof darkQuery.addListener === 'function') {
        darkQuery.addListener(onSystemChange);
      }
    }
  }

  function onSystemChange(event) {
    if (root.getAttribute('data-theme') !== 'system') return;
    root.setAttribute('data-theme', event.matches ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', event.matches ? BAR.dark : BAR.light);
  }

  window.__xahTheme = apply;

  try {
    var stored = localStorage.getItem(STORAGE_KEY);

    // The cookie is read as well as localStorage, and wins when both are
    // present. It is what the server used to render the switcher's checked
    // state, so preferring it keeps the control and the painted theme in
    // agreement. A reader with an old cookie and no localStorage entry — or
    // the reverse, after clearing one but not the other — would otherwise see
    // the control show one state and the page paint in another.
    var match = document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark|system)/);
    if (match) stored = match[1];

    apply(VALID.indexOf(stored) === -1 ? 'system' : stored);
  } catch (error) {
    // Storage unavailable. \`system\` is still correct, because the stylesheet
    // resolves it through prefers-color-scheme on its own.
    apply('system');
  }
})();`;

/**
 * Applies a change from the switcher, then remembers it.
 *
 * Applying is not optional and was the bug this replaced: the handler used to only write
 * localStorage and the cookie, on the assumption that the radio's `:checked` state plus
 * CSS would repaint the page. It does not — that rule only highlights the control. The
 * theme is driven by `data-theme` on <html>, which nothing was writing, so clicking
 * "dark" moved the highlight and left the page light until a reload.
 *
 * `window.__xahTheme` is the shared apply function installed by the head script, so the
 * two call sites cannot drift. The inline-script guard is because a reader can reach this
 * code with the head script having thrown.
 */
export const THEME_BODY_SCRIPT = `document.addEventListener('change', function (event) {
  var input = event.target;
  if (!input || input.name !== 'theme') return;
  // Validated against the same three states the control offers, so a
  // synthetic \`change\` event carrying anything else cannot be applied or
  // persisted.
  if (['light', 'dark', 'system'].indexOf(input.value) === -1) return;

  if (typeof window.__xahTheme === 'function') window.__xahTheme(input.value);

  try {
    localStorage.setItem('${THEME_STORAGE_KEY}', input.value);
  } catch (error) {
    // Private browsing. The cookie below still carries the choice across
    // navigations, and the theme applies for this page view regardless.
  }
  // A cookie as well as localStorage, because localStorage is invisible to the
  // server. Without it the switcher would render in the \`system\` position on
  // every page load even though the theme itself was right, which reads as the
  // control not having taken the click.
  document.cookie = '${THEME_COOKIE}=' + input.value + '; path=/; max-age=31536000; samesite=lax';
});`;