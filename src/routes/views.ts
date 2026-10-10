/** SPEC §16 — Admin UI. Server-rendered HTML, no client framework. */

import { escapeHtml } from '../lib/http';
import { FALLBACK_SITE_NAME } from '../config/site';
import { MANIFEST_HREF, SITE_ICONS, THEME_COLOR, iconLinkHtml } from '../config/icons';
import { THEME_BODY_SCRIPT, THEME_HEAD_SCRIPT, THEME_OPTIONS } from '../lib/theme';
import { ICON_PATHS, ICON_VIEW_BOX } from '../icons/phosphor';
import type { ArticleRow } from '../db/rows';
import type { ArticleStatus } from '../jobs/types';

export interface LayoutOptions {
  title: string;
  active: 'dashboard' | 'import' | 'articles' | 'jobs';
  siteName: string;
}

/**
 * SPEC §33 — the three-state theme control, in the topbar's right-hand corner.
 *
 * It replaces a label that read `Phase 1`, which was a build-milestone marker with no
 * meaning for anyone but the author, in the one corner of every admin page an operator
 * looks at. The control is the public header's, same three states, same glyphs, same
 * shared scripts — a person who picked dark while reading should not find the admin back
 * in light, and two controls would be two behaviours to keep in step.
 *
 * Generated from `THEME_OPTIONS` rather than hand-written, and the markup mirrors
 * `ThemeSwitch.astro`: a fieldset whose legend names the radio group for assistive tech,
 * labels wrapping visually-hidden inputs so the control is keyboard navigable and works
 * before any script, and CSS doing the highlighting through `:has(input:checked)`.
 *
 * No input is rendered `checked`. The public pages server-render it from the cookie
 * through `Astro.cookies`; the admin has no such plumbing — the choice would have to be
 * threaded through seven view functions and their seven call sites for a first-paint nicety
 * nobody will ever notice. The body script below syncs the control to the already-painted
 * `data-theme` instead, which costs a few milliseconds of unselected state after parse and
 * touches nothing else. The painted theme itself is correct from the first frame, because
 * the head script reads the same cookie.
 */
function themeSwitchHtml(): string {
  const options = THEME_OPTIONS.map(
    (option) =>
      `<label class="theme-switch__option" title="${escapeHtml(option.label)}">` +
      `<input type="radio" name="theme" value="${option.value}" aria-label="${escapeHtml(option.label)}">` +
      `<svg class="theme-switch__icon" viewBox="${ICON_VIEW_BOX}" width="15" height="15" ` +
      `fill="currentColor" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[option.icon]}"></path></svg>` +
      `</label>`,
  ).join('');

  return (
    `<fieldset class="theme-switch"><legend class="visually-hidden">Colour theme</legend>` +
    `<div class="theme-switch__options" role="radiogroup" aria-label="Colour theme">${options}</div>` +
    `</fieldset>`
  );
}

const NAV: Array<{ key: LayoutOptions['active']; href: string; label: string }> = [
  { key: 'dashboard', href: '/admin', label: 'Dashboard' },
  { key: 'import', href: '/admin/import', label: 'Import' },
  { key: 'articles', href: '/admin/articles', label: 'Articles' },
  { key: 'jobs', href: '/admin/jobs', label: 'Jobs' },
];

/**
 * Puts the control's checked state where the painted theme already is.
 *
 * Admin-only, and the reason it exists is spelled out at `themeSwitchHtml`: the public
 * pages render `checked` from the cookie server-side and the admin does not, so nothing
 * else would put the highlight on the right option until the reader clicked something.
 *
 * Reads `data-theme` rather than the cookie on purpose. The attribute is what the page is
 * actually painted from, so syncing to it means the control cannot disagree with the
 * surface even if the two disagree — the alternative, reading the cookie again here, can
 * reproduce exactly the split it is meant to prevent.
 *
 * The guard covers the case where the head script threw before writing anything: with no
 * attribute there is nothing authoritative to sync to, and leaving all three unselected is
 * more honest than picking one.
 */
const THEME_CONTROL_SYNC_SCRIPT = `(function () {
  var choice = document.documentElement.getAttribute('data-theme');
  if (choice !== 'light' && choice !== 'dark' && choice !== 'system') return;
  var inputs = document.querySelectorAll('.theme-switch__option input[name="theme"]');
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].value === choice) {
      // Property and attribute, not just the property. Setting \`checked\` alone drives the
      // rendering — the \`:has(input:checked)\` rule matches on the property, so the
      // highlight is right either way — but the property does not reflect back to the
      // content attribute, which leaves the serialised DOM of this page carrying no
      // checked state at all while the public pages, whose Astro-rendered inputs do, look
      // different from it. One call makes the two surfaces produce the same markup and
      // makes the state readable by anything that inspects the DOM.
      inputs[i].checked = true;
      inputs[i].setAttribute('checked', 'checked');
      return;
    }
  }
})();`;

export function layout(options: LayoutOptions, body: string): string {
  const nav = NAV.map(
    (item) =>
      `<a class="nav-link${item.key === options.active ? ' is-active' : ''}" href="${item.href}">${escapeHtml(item.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)} · ${escapeHtml(options.siteName)} Admin</title>
${SITE_ICONS.map(iconLinkHtml).join('\n')}
<link rel="manifest" href="${MANIFEST_HREF}">
<meta name="theme-color" content="${THEME_COLOR}">
<link rel="stylesheet" href="/admin.css">
<script>${THEME_HEAD_SCRIPT}</script>
</head>
<body>
<header class="topbar">
  <div class="brand"><img class="brand-mark" src="/logo-mark.png" width="72" height="72" alt="" decoding="async"><img class="brand-mark brand-mark-inverse" src="/logo-mark-inverse.png" width="72" height="72" alt="" decoding="async">${escapeHtml(options.siteName)} <span class="brand-tag">admin</span></div>
  <nav class="nav">${nav}</nav>
  ${themeSwitchHtml()}
</header>
<main class="main">
${body}
</main>
<script>${THEME_BODY_SCRIPT}</script>
<script>${THEME_CONTROL_SYNC_SCRIPT}</script>
</body>
</html>`;
}

// --- dashboard (SPEC §16.1) -----------------------------------------------

export interface DashboardView {
  total: number;
  articles: Record<string, number>;
  today: { imported: number; published: number; failed: number };
  /**
   * SPEC §21 — set after a manual ranking refresh, so the run reports what it did rather
   * than leaving the operator to infer it from the board reordering.
   */
  refreshed?: { scored: number; withoutMetrics: number };
}

const STATUS_ORDER: ArticleStatus[] = [
  'published',
  'review',
  'parsing',
  'fetching',
  'fetched',
  'pending',
  'failed',
  'rejected',
  'archived',
  'takedown',
];

export function dashboardView(view: DashboardView, siteName: string = FALLBACK_SITE_NAME): string {
  const rows = STATUS_ORDER.map((status) => {
    const count = view.articles[status] ?? 0;
    return `<tr>
      <td><a href="/admin/articles?status=${status}"><span class="pill pill-${status}">${escapeHtml(status)}</span></a></td>
      <td class="num">${count}</td>
      <td class="num">${view.total ? Math.round((count / view.total) * 100) : 0}%</td>
    </tr>`;
  }).join('');

  const cards = [
    { label: 'Total articles', value: view.total },
    { label: 'Imported today', value: view.today.imported },
    { label: 'Published today', value: view.today.published },
    { label: 'Failed today', value: view.today.failed },
  ]
    .map((card) => `<div class="card"><div class="card-value">${card.value}</div><div class="card-label">${escapeHtml(card.label)}</div></div>`)
    .join('');

  /**
   * SPEC §21 — the ranking refresh, on demand.
   *
   * The cron runs it every 30 minutes, so this is not the normal path. It exists because
   * the refresh is otherwise unobservable: `/trending` reorders, and a reader has no way to
   * tell a working ranking from a stale one. Pressing this after importing makes the change
   * immediate and states what it did.
   *
   * The `withoutMetrics` count is the part that matters. `final_score` puts an article with
   * no engagement data at the bottom either way, so a crawl whose selectors stopped matching
   * produces no error — just a board that slowly equals `/latest`. This is where that number
   * becomes visible.
   */
  const refreshBanner = view.refreshed
    ? `<div class="banner banner-ok">
        Ranking recomputed for <strong>${view.refreshed.scored}</strong> published article${view.refreshed.scored === 1 ? '' : 's'}.${
          view.refreshed.withoutMetrics > 0
            ? ` <strong>${view.refreshed.withoutMetrics}</strong> had no engagement data and scored 0 on popularity.`
            : ''
        }
      </div>`
    : '';

  return layout(
    { title: 'Dashboard', active: 'dashboard', siteName }, 
    `<h1>Dashboard</h1>
<p class="lede">Curation pipeline status. Import URLs to create articles; crawling starts in Phase 2.</p>
${refreshBanner}
<div class="cards">${cards}</div>
<h2>Ranking</h2>
<p class="lede">Scores are recomputed on a schedule (SPEC §21) and can be run now.</p>
<form method="post" action="/admin/ranking/refresh" class="action-inline">
  <button class="button" type="submit">Recompute ranking scores</button>
  <span class="hint">Reads the newest engagement snapshot per article and rewrites every score.</span>
</form>
<h2>Articles by status</h2>
<table class="table">
  <thead><tr><th>Status</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3">No articles yet.</td></tr>'}</tbody>
</table>`,
  );
}

// --- import (SPEC §16.2) ---------------------------------------------------

export interface ImportView {
  result?: {
    created: number;
    duplicates: number;
    failed: number;
    articles: Array<{ id: string; status: string; canonicalUrl: string; jobId: string }>;
    outcomes: Array<{
    status: string;
    input: string;
    canonicalUrl?: string;
    articleId?: string;
    /**
     * The existing article's workflow status, present on `duplicate` outcomes only.
     *
     * Rendered as a second pill beside the outcome, because the two answer different
     * questions and an operator needs both: "did this import do anything" and "what
     * happened to the article that was already there".
     */
    articleStatus?: string;
    code?: string;
    message?: string;
  }>;
  };
  error?: string;
}

/**
 * What each import outcome is called in this UI.
 *
 * `duplicate` is the wire value and stays that way — `scripts/smoke.sh` asserts on it and
 * it is part of the SPEC §22 response shape. What changes is the word on screen, because
 * "duplicate" describes what the import did rather than what happened to the article, and
 * an operator re-importing a URL could not tell a published article from one still
 * waiting in review. "already imported" says the same thing accurately and answers the
 * question they were actually asking.
 */
const OUTCOME_LABEL: Record<string, string> = {
  created: 'created',
  duplicate: 'already imported',
  failed: 'failed',
};

export function importView(view: ImportView, siteName: string = FALLBACK_SITE_NAME): string {
  let banner = '';
  if (view.error) {
    banner = `<div class="banner banner-error">${escapeHtml(view.error)}</div>`;
  } else if (view.result) {
    const r = view.result;
    const tone = r.failed > 0 ? 'banner-warn' : 'banner-ok';
    banner = `<div class="banner ${tone}">
      <strong>Imported.</strong> ${r.created} created · ${r.duplicates} already imported · ${r.failed} rejected
    </div>`;

    const rows = r.outcomes
      .map(
        (o) => `<tr>
        <td><span class="pill-group"><span class="pill pill-${escapeHtml(o.status)}">${escapeHtml(OUTCOME_LABEL[o.status] ?? o.status)}</span>${
          o.articleStatus
            ? `<span class="pill pill-${escapeHtml(o.articleStatus)}">${escapeHtml(o.articleStatus)}</span>`
            : ''
        }</span></td>
        <td class="wrap">${escapeHtml(o.input)}</td>
        <td>${o.canonicalUrl ? `<a href="${escapeHtml(o.canonicalUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(o.canonicalUrl)}</a>` : '—'}</td>
        <td>${o.articleId ? `<a href="/admin/articles/${escapeHtml(o.articleId)}"><code>${escapeHtml(o.articleId)}</code></a>` : '—'}</td>
        <td class="wrap">${escapeHtml(o.code ? `${o.code}: ${o.message ?? ''}` : '')}</td>
      </tr>`,
      )
      .join('');

    banner += `<table class="table">
      <thead><tr><th>Result</th><th>Input</th><th>Canonical URL</th><th>Article</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const body = `<h1>Import X Articles</h1>
<p class="lede">Paste one article URL per line. Blank lines, commas and semicolons are ignored.
Duplicates are detected by canonical URL and never create a second article.</p>
<form class="card card-form" method="post" action="/admin/import">
  <label class="label" for="urls">Article URLs</label>
  <textarea id="urls" name="urls" rows="12" spellcheck="false" placeholder="https://x.com/username/article/123456789&#10;https://x.com/another/article/987654321"></textarea>
  <div class="form-actions">
    <button class="button" type="submit">Import</button>
    <span class="hint">URLs are normalized and queued. Import never waits for a crawl.</span>
  </div>
</form>
${banner}`;

  return layout({ title: 'Import', active: 'import', siteName },  body);
}

// --- article list ----------------------------------------------------------

export interface ArticleListItem {
  id: string;
  title: string;
  canonical_url: string;
  status: string;
  imported_at: number;
  author_username: string | null;
}

export interface ArticleListView {
  /**
   * `ArticleRow`, not `ArticleListItem`.
   *
   * The list view renders the admin table from `listArticles`, which returns the full row —
   * it needs `canonical_url` for the source link, `imported_at` for the timestamp, and now
   * `slug` for the delete confirmation. The declaration said `ArticleListItem` and nothing
   * caught it because every field the template read happened to exist on both; the first
   * field that did not was `slug`.
   */
  articles: ArticleRow[];
  status: string | null;
  statuses: string[];
  /** Set when the request carries `?published=1`, i.e. a quick action just ran. */
  published?: boolean;
  /**
   * SPEC §16 — what a delete just removed. Set from `?deleted=1`, and carries the counts so
   * the message can name them: "deleted" without a number gives no way to tell a full delete
   * from one that swept an empty prefix.
   */
  deleted?: { slug: string | null; objects: number; bytes: number };
}

export function articleListView(view: ArticleListView, siteName: string = FALLBACK_SITE_NAME): string {
  const filter = view.statuses
    .map(
      (s) =>
        `<a class="chip${s === (view.status ?? '') ? ' is-active' : ''}" href="/admin/articles?status=${s}">${escapeHtml(s)}</a>`,
    )
    .join('');

  /**
   * SPEC §16.3 — a one-click publish for the rows that are waiting on it.
   *
   * Only `review` gets the button. That is the state an editor has actually looked at and
   * decided on — the article has been fetched and parsed and is sitting there asking to go
   * out. Every other state either has nothing to publish yet (`pending`/`fetching`/
   * `fetched`/`parsing`), is already out (`published`), or was deliberately stopped
   * (`rejected`/`archived`/`takedown`/`failed`), and offering publish on those would be
   * offering a transition the state machine does not have.
   *
   * A `<form>`, not a link: publishing is a state change, and a GET that changes state is
   * what lets a prefetch or a link preview publish something. The detail page's Publish is
   * a form for the same reason.
   *
   * `from=list` travels with it so the handler can send the editor back to the row they
   * were looking at. Without it the redirect goes to the article detail page, which is the
   * right destination for the detail page's own buttons and the wrong one here — clicking
   * publish on row 7 of a filtered list should leave you on row 7 of that list, not on a
   * different page with no way back to where you were.
   */
  const publishCell = (status: string, id: string, filter: string | null) =>
    status === 'review'
      ? `<form method="post" action="/admin/articles/${escapeHtml(id)}/publish" class="row-action">
      <input type="hidden" name="from" value="list">
      ${filter ? `<input type="hidden" name="status" value="${escapeHtml(filter)}">` : ''}
      <button class="button button-small" type="submit" title="Publish this article">Publish</button>
    </form>`
      : '';

  /**
   * SPEC §16 — the row's delete button.
   *
   * Every row gets one, unlike Publish, because delete is not a state transition: any
   * article can be removed regardless of where it is in the pipeline, and refusing on
   * `published` would mean the only way to remove a bad import is to archive it first.
   *
   * The confirmation is the row's own title rather than a typed slug. A table cell has no
   * room for an input, and this is the shortcut: the detail page is where the deliberate,
   * type-it-out version lives. The browser dialog is a guard against a misclick, not a
   * security boundary — the server checks that the confirmation field is present and equal
   * to the slug, so a bare POST to this URL does nothing.
   */
  const deleteCell = (id: string, label: string, slug: string | null) =>
    `<form method="post" action="/admin/articles/${escapeHtml(id)}/delete" class="row-action"
           onsubmit="return confirm('Delete &quot;' + ${JSON.stringify(label)} + '&quot; and everything archived for it?\\n\\nThis cannot be undone.')">
      <input type="hidden" name="confirm" value="${escapeHtml(slug ?? id)}">
      <button class="button button-small button-danger" type="submit" title="Delete permanently">Delete</button>
    </form>`;

  const rows = view.articles
    .map(
      (a) => `<tr>
      <td><span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
      <td class="wrap"><a href="/admin/articles/${escapeHtml(a.id)}">${escapeHtml(a.title || a.canonical_url)}</a></td>
      <td>${escapeHtml(a.author_username ?? '—')}</td>
      <td class="num">${escapeHtml(new Date(a.imported_at).toISOString().replace('T', ' ').slice(0, 16))}</td>
      <td class="wrap"><a href="${escapeHtml(a.canonical_url)}" target="_blank" rel="noreferrer noopener">source</a></td>
      <td class="num">${publishCell(a.status, a.id, view.status)}</td>
      <td class="num">${deleteCell(a.id, a.title || a.canonical_url, a.slug)}</td>
    </tr>`,
    )
    .join('');

  /**
   * SPEC §16.3 — what the quick action did.
   *
   * Without this the redirect lands on the list with the row's pill changed from `review`
   * to `published` and nothing else, which is easy to miss when the list is filtered to
   * `review`: the row is simply gone, and a row disappearing is indistinguishable from a
   * filter being wrong or the page reloading to something unexpected.
   */
  const deleteBanner = view.deleted
    ? `<div class="banner banner-ok">
        Deleted${view.deleted.slug ? ` <code>${escapeHtml(view.deleted.slug)}</code>` : ''} —
        ${view.deleted.objects} archived object${view.deleted.objects === 1 ? '' : 's'}
        (${formatBytes(view.deleted.bytes)}) removed, along with every row referencing it.
      </div>`
    : '';

  const banner = view.published
    ? '<div class="banner banner-ok">Published. It is live at <a href="/latest">the public site</a>.</div>'
    : deleteBanner;

  const body = `<h1>Articles</h1>
${banner}
<div class="chips">${filter}</div>
${
  view.articles.length === 0
    ? '<div class="card empty">No articles match this filter. <a href="/admin/import">Import some URLs</a> to get started.</div>'
    : `<table class="table">
  <thead><tr><th>Status</th><th>Title</th><th>Author</th><th class="num">Imported</th><th></th><th></th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}
${renderPager(view.articles.length)}`;

  return layout({ title: 'Articles', active: 'articles', siteName },  body);
}

function renderPager(count: number): string {
  if (count < 50) return '';
  return '<p class="hint">Showing the first page. Use <code>/api/admin/articles?limit=&amp;offset=</code> for pagination.</p>';
}

// --- article detail --------------------------------------------------------

export interface ArticleDetailView {
  article: ArticleRow;
  jobs: Array<{
    id: string;
    job_type: string;
    status: string;
    attempt_count: number;
    deliveries: number;
    error_code: string | null;
    error_message: string | null;
    created_at: number;
    updated_at: number;
  }>;
  events: Array<{ id: string; action: string; actor: string; note: string | null; created_at: number }>;
  /**
   * SPEC §13.5 — every category, so the editor can pick one. Loaded here rather than
   * joined into the article row because this is the only admin surface that offers the
   * choice, and a picker with no options is how a feature ends up looking absent.
   */
  categories: Array<{ id: string; slug: string; name: string }>;
  raw?: { archived: boolean; markdownBytes: number; htmlBytes: number; r2Key: string | null } | null;
  parsed?: { contentR2Key: string | null; blockCount: number; wordCount: number; parserVersion: number } | null;
  /** SPEC §10 — per-image media state, so "archived" is a claim you can check. */
  media?: {
    imageId: string;
    position: number;
    kind: 'body' | 'avatar';
    status: 'ready' | 'failed' | 'external_fallback';
    contentType: string | null;
    byteSize: number | null;
    width: number | null;
    height: number | null;
    altText: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    attempts: number;
  }[];
  notice?: string | null;
  error?: string | null;
}

export function articleDetailView(view: ArticleDetailView, siteName: string = FALLBACK_SITE_NAME): string {
  const a = view.article;

  const jobRows = view.jobs
    .map(
      (j) => `<tr>
      <td><code>${escapeHtml(j.id)}</code></td>
      <td>${escapeHtml(j.job_type)}</td>
      <td><span class="pill pill-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span></td>
      <td class="num">${j.attempt_count}</td>
      <td class="num">${j.deliveries}</td>
      <td class="wrap">${escapeHtml(j.error_code ? `${j.error_code}: ${j.error_message ?? ''}` : '—')}</td>
      <td class="num">${escapeHtml(ts(j.updated_at))}</td>
    </tr>`,
    )
    .join('');

  const eventRows = view.events
    .map(
      (e) => `<tr>
      <td>${escapeHtml(e.action)}</td>
      <td>${escapeHtml(e.actor)}</td>
      <td class="wrap">${escapeHtml(e.note ?? '—')}</td>
      <td class="num">${escapeHtml(ts(e.created_at))}</td>
    </tr>`,
    )
    .join('');

  /**
   * Which of the three columns is currently deciding the article's category, and what the
   * picker can honestly show.
   *
   * They are read as `COALESCE(editor_category_id, category_id)` everywhere, so this is
   * the same precedence — stated rather than recomputed, because a picker that shows the
   * effective value without saying where it came from is how an editor ends up "fixing"
   * a value that was never wrong.
   *
   * The stored id is then checked against the list before it is offered back. A dangling
   * one predates the service validating its input, and it is invisible by construction:
   * the join cannot match it, so the article is in no category, while the column still
   * holds a value. Rendering that as a selection would claim otherwise, and leaving the
   * select with nothing selected would make the page depend on which option a browser
   * happens to default to. `ai_category` holds a slug where the other two hold ids, so
   * it is compared as text only.
   */
  const storedCategoryId = a.editor_category_id ?? a.category_id;
  const effectiveCategoryId = view.categories.some((c) => c.id === storedCategoryId) ? storedCategoryId : null;
  const categorySource = !effectiveCategoryId && storedCategoryId
    ? `a stale value (${storedCategoryId}) that no longer matches any category — saving will clear it`
    : a.editor_category_id
      ? 'from your override'
      : a.category_id
        ? a.ai_category
          ? 'from the AI suggestion, which has been accepted'
          : 'assigned directly'
        : 'nothing has categorised this article — the AI step does not exist yet, so this is the only way in';

  const categoryOptions = [
    `<option value=""${effectiveCategoryId ? '' : ' selected'}>— none —</option>`,
    ...view.categories.map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === effectiveCategoryId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
    ),
  ].join('');

  const body = `<p class="crumb"><a href="/admin/articles">← All articles</a></p>
<h1>${escapeHtml(a.title || a.canonical_url)}</h1>
<div class="meta-row">
  <span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
  <span class="pill">${escapeHtml(a.display_mode)}</span>
  ${a.featured ? '<span class="pill pill-featured">featured</span>' : ''}
  <span class="hint">parser v${a.parser_version}</span>
</div>

<section class="card">
  <h2>Source</h2>
  <dl class="kv">
    <dt>Original URL</dt><dd><a href="${escapeHtml(a.canonical_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(a.canonical_url)}</a></dd>
    <dt>Site slug</dt><dd>${escapeHtml(a.slug ?? '—')}</dd>
    <dt>Article ID</dt><dd><code>${escapeHtml(a.id)}</code></dd>
    <dt>Imported</dt><dd>${escapeHtml(ts(a.imported_at))}</dd>
    <dt>Updated</dt><dd>${escapeHtml(ts(a.updated_at))}</dd>
  </dl>
  <div class="action-grid">
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/retry">
      <button class="button button-secondary" type="submit">Retry crawl job</button>
      <span class="hint">Re-queues the message for the consumer.</span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/crawl">
      <button class="button button-secondary" type="submit">Crawl now</button>
      <span class="hint">Runs Browser Run immediately. Costs browser time.</span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/parse">
      <button class="button button-secondary" type="submit">Parse</button>
      <span class="hint">
        Raw archive → ArticleDocument. Reads only R2, so it is free and never touches X.
      </span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/media">
      <button class="button button-secondary" type="submit"${a.content_r2_key ? '' : ' disabled'}>Archive images</button>
      <span class="hint">
        Fetches every image from x.com into R2, so the article stops depending on their CDN. Re-run to retry failures.
      </span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/featured">
      <button class="button button-secondary" type="submit">${a.featured ? 'Unfeature' : "Feature"}</button>
      <span class="hint">Editor's Pick — a human decision, not a score.</span>
    </form>
  </div>
</section>

<section class="card">
  <h2>Curation (SPEC §16.3)</h2>
  ${
    view.error
      ? `<div class="banner banner-error">${escapeHtml(view.error)}</div>`
      : `<div class="banner">Archived copy only. Publishing is the editor's call — the AI never publishes (§4.7).</div>`
  }
  <div class="action-grid">
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/publish">
      <button class="button" type="submit"${a.status === 'published' ? ' disabled' : ''}>Publish</button>
      <span class="hint">Makes it public at /article/${escapeHtml(a.slug ?? '')}</span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/reject">
      <button class="button button-secondary" type="submit">Reject</button>
      <span class="hint">Not worth archiving.</span>
    </form>
    <form method="post" action="/admin/articles/${escapeHtml(a.id)}/archive">
      <button class="button button-secondary" type="submit">Archive</button>
      <span class="hint">Keep the capture, hide it.</span>
    </form>
  </div>

  <form method="post" action="/admin/articles/${escapeHtml(a.id)}/category" class="action-inline">
    <label class="label" for="categoryId">Category</label>
    <select id="categoryId" name="categoryId">${categoryOptions}</select>
    <button class="button" type="submit">Save</button>
    <span class="hint">
      Counts toward the category pages and the header chips. Your choice wins over an
      AI suggestion; pick "— none —" to hand it back. Currently ${escapeHtml(categorySource)}.
    </span>
  </form>

  ${
    a.display_mode === 'takedown' || a.status === 'takedown'
      ? `<form method="post" action="/admin/articles/${escapeHtml(a.id)}/restore" class="action-inline">
    <label class="label" for="dm">Restore as</label>
    <select id="dm" name="displayMode">
      <option value="full">full — body + original link</option>
      <option value="excerpt">excerpt — notice only</option>
      <option value="link_only">link_only — title + original link, no body</option>
    </select>
    <button class="button" type="submit">Restore</button>
    <span class="hint">Returns it to published, since a takedown only ever applied to something already public.</span>
  </form>`
      : `<form method="post" action="/admin/articles/${escapeHtml(a.id)}/takedown" class="action-inline">
    <label class="label" for="reason">Takedown reason (required)</label>
    <input id="reason" name="reason" type="text" placeholder="e.g. author requested removal" required>
    <button class="button button-danger" type="submit">Takedown</button>
    <span class="hint">Removes it from lists, sitemap, feed and search immediately. The page then explains itself rather than 404ing.</span>
  </form>`
  }
</section>

<section class="card card-danger">
  <h2>Delete</h2>
  <p class="lede">
    Removes the article and everything belonging to it: the row, its version history, its
    crawl job records, its curation log, its media rows, and every object stored under its
    archive prefix — raw captures, every parsed version, every image and avatar.
  </p>
  <p class="lede">
    <strong>This cannot be undone.</strong> There is no soft delete behind it and no backup.
    If the point is to stop the article being shown, use <em>Archive</em> or <em>Takedown</em>
    above instead — both keep the capture and both are reversible.
  </p>
  <form method="post" action="/admin/articles/${escapeHtml(a.id)}/delete" class="action-inline">
    <label class="label" for="confirm">
      Type <code>${escapeHtml(a.slug ?? a.id)}</code> to confirm
    </label>
    <input id="confirm" name="confirm" type="text" autocomplete="off" required
           placeholder="${escapeHtml(a.slug ?? a.id)}">
    <button class="button button-danger" type="submit">Delete permanently</button>
  </form>
</section>

<section class="card">
  <h2>Parsed document (SPEC §9)</h2>
  ${
    view.parsed?.contentR2Key
      ? `<dl class="kv">
    <dt>R2 key</dt><dd><code>${escapeHtml(view.parsed.contentR2Key)}</code></dd>
    <dt>Parser version</dt><dd>v${view.parsed.parserVersion}</dd>
    <dt>Blocks</dt><dd>${view.parsed.blockCount}</dd>
    <dt>Words</dt><dd>${view.parsed.wordCount.toLocaleString()}</dd>
  </dl>
  <p class="hint">The reading page renders from this document.</p>`
      : `<p class="hint">Not parsed yet. The reading page stays empty until the Parser runs.</p>`
  }
  ${view.notice ? `<div class="banner banner-ok">${escapeHtml(view.notice)}</div>` : ''}
</section>

<section class="card">
  <h2>Media (SPEC §10)</h2>
  ${
    !view.media || view.media.length === 0
      ? `<p class="hint">
           No media run yet. The reading page still points every figure at x.com's CDN, so the archive is not
           self-sufficient — X can delete a post or replace an image and this article loses it.
         </p>`
      : (() => {
          const ready = view.media!.filter((m) => m.status === 'ready');
          const failed = view.media!.filter((m) => m.status === 'failed');
          const fallback = view.media!.filter((m) => m.status === 'external_fallback');
          const bytes = ready.reduce((sum, m) => sum + (m.byteSize ?? 0), 0);
          const kb = (bytes / 1024).toFixed(0);
          return `<dl class="kv">
    <dt>Archived</dt><dd>${ready.length} of ${view.media!.length} (${kb} KB in R2)</dd>
    <dt>Still on X's CDN</dt><dd>${fallback.length}</dd>
    <dt>Given up on</dt><dd>${failed.length}</dd>
  </dl>
  <table class="table">
    <thead><tr><th>#</th><th>Status</th><th>Type</th><th>Size</th><th>Dimensions</th><th>Note</th></tr></thead>
    <tbody>
      ${view.media!
        .map(
          (m) => `<tr>
        <td>${m.kind === 'avatar' ? 'avatar' : String(m.position).padStart(3, '0')}</td>
        <td>${m.status === 'ready' ? 'archived' : m.status === 'failed' ? 'failed' : 'on x.com'}</td>
        <td>${m.contentType ? escapeHtml(m.contentType) : '—'}</td>
        <td>${m.byteSize ? `${(m.byteSize / 1024).toFixed(0)} KB` : '—'}</td>
        <td>${m.width && m.height ? `${m.width}×${m.height}` : '—'}</td>
        <td>${m.errorCode ? `<code>${escapeHtml(m.errorCode)}</code> ${escapeHtml(m.errorMessage ?? '')}` : ''}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
  ${
    fallback.length > 0 || failed.length > 0
      ? `<p class="hint">
           Figures still on x.com are shown to readers as a labelled link rather than a hotlinked
           <code>&lt;img&gt;</code>, so nobody mistakes a CDN image for an archived one.
         </p>`
      : ''
  }`;
        })()
  }
</section>

<section class="card">
  <h2>Raw archive (SPEC §8)</h2>
  ${
    view.raw?.archived
      ? `<dl class="kv">
    <dt>R2 key</dt><dd><code>${escapeHtml(view.raw.r2Key ?? '')}</code></dd>
    <dt>Markdown</dt><dd>${view.raw.markdownBytes.toLocaleString()} bytes</dd>
    <dt>HTML</dt><dd>${view.raw.htmlBytes.toLocaleString()} bytes</dd>
  </dl>
  <p class="hint">
    <a href="/api/admin/articles/${escapeHtml(a.id)}/raw?format=markdown" target="_blank" rel="noreferrer">View raw Markdown</a>
    &nbsp;·&nbsp;
    <a href="/api/admin/articles/${escapeHtml(a.id)}/raw?format=html" target="_blank" rel="noreferrer">View raw HTML</a>
  </p>`
      : '<p class="hint">No raw archive yet. The crawl has not completed for this article.</p>'
  }
</section>

<section class="card">
  <h2>Jobs</h2>
  ${
    view.jobs.length === 0
      ? '<p class="hint">No jobs.</p>'
      : `<table class="table">
    <thead><tr><th>Job</th><th>Type</th><th>Status</th><th class="num">Attempts</th><th class="num">Deliveries</th><th>Error</th><th class="num">Updated</th></tr></thead>
    <tbody>${jobRows}</tbody>
  </table>`
  }
</section>

<section class="card">
  <h2>Curation events</h2>
  ${
    view.events.length === 0
      ? '<p class="hint">No events.</p>'
      : `<table class="table">
    <thead><tr><th>Action</th><th>Actor</th><th>Note</th><th class="num">When</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table>`
  }
</section>`;

  return layout({ title: a.title || a.id, active: 'articles', siteName },  body);
}

// --- jobs (SPEC §16.4) -----------------------------------------------------

export interface JobListView {
  jobs: Array<{
    id: string;
    article_id: string;
    job_type: string;
    status: string;
    attempt_count: number;
    error_code: string | null;
    error_message: string | null;
    updated_at: number;
  }>;
}

export function jobListView(view: JobListView, siteName: string = FALLBACK_SITE_NAME): string {
  const rows = view.jobs
    .map(
      (j) => `<tr>
      <td><code>${escapeHtml(j.id)}</code></td>
      <td><a href="/admin/articles/${escapeHtml(j.article_id)}"><code>${escapeHtml(j.article_id)}</code></a></td>
      <td>${escapeHtml(j.job_type)}</td>
      <td><span class="pill pill-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span></td>
      <td class="num">${j.attempt_count}</td>
      <td class="wrap">${escapeHtml(j.error_code ? `${j.error_code}: ${j.error_message ?? ''}` : '—')}</td>
      <td class="num">${escapeHtml(ts(j.updated_at))}</td>
    </tr>`,
    )
    .join('');

  const body = `<h1>Jobs</h1>
<p class="lede">Failed jobs only. <em>Retry</em> and <em>View raw HTML</em> land with the Phase 2 crawl.</p>
${
  view.jobs.length === 0
    ? '<div class="card empty">No failed jobs. </div>'
    : `<table class="table">
  <thead><tr><th>Job</th><th>Article</th><th>Type</th><th>Status</th><th class="num">Attempts</th><th>Error</th><th class="num">Updated</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}`;

  return layout({ title: 'Jobs', active: 'jobs', siteName },  body);
}

// --- login (dev shim) ------------------------------------------------------

/**
 * SPEC §43 — the token form is the fallback, not the only way in.
 *
 * A real account with `role = 'admin'` authenticates the same as the token
 * (`resolveAccountIdentity` in src/middleware/admin-auth.ts), but a browser cannot get
 * signed in by itself: it has to visit /account first. So the way through is linked here,
 * carrying `next=/admin` so the reader lands back on the admin dashboard rather than on
 * their own account page with no idea what to do next.
 *
 * The wording says "configured" rather than naming a provider because this view has no
 * access to `Env`. Listing a method that turns out not to be configured would be worse
 * than not listing it — /account shows exactly which providers are live, and the link
 * goes there.
 */
export function loginView(message?: string, siteName: string = FALLBACK_SITE_NAME): string {
  const banner = message ? `<div class="banner banner-error">${escapeHtml(message)}</div>` : '';
  const body = `<h1>Admin sign in</h1>
<p class="lede">Admin is protected by Cloudflare Access in production (SPEC §24). This form only
exists for local development, where you set the <code>ADMIN_TOKEN</code> secret.</p>
<p class="lede">If your account has admin rights, <a href="/account?next=%2Fadmin">sign in with X or Google</a>
instead and you will be brought straight back here.</p>
${banner}
<form class="card card-form" method="post" action="/admin/login">
  <label class="label" for="token">Admin token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required>
  <div class="form-actions"><button class="button" type="submit">Sign in</button></div>
</form>`;

  return layout({ title: 'Sign in', active: 'dashboard', siteName },  body);
}

export function errorView(status: number, code: string, message: string, siteName: string = FALLBACK_SITE_NAME): string {
  const body = `<h1>${status}</h1>
<div class="card"><p><strong>${escapeHtml(code)}</strong></p><p>${escapeHtml(message)}</p>
<p class="hint"><a href="/admin">Back to dashboard</a></p></div>`;
  return layout({ title: `${status}`, active: 'dashboard', siteName },  body);
}

/**
 * Bytes at a human scale.
 *
 * Three call sites were each formatting this inline and two of them disagreed on precision,
 * so one article's size read "2.1 MB" in the storage list and "2178 KB" on its own page.
 * Kept here rather than in a lib because every caller is a view, and the unit a reader wants
 * is a presentation choice.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ts(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}
