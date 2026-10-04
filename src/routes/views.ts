/** SPEC §16 — Admin UI. Server-rendered HTML, no client framework. */

import { escapeHtml } from '../lib/http';
import { FALLBACK_SITE_NAME } from '../config/site';
import { MANIFEST_HREF, SITE_ICONS, THEME_COLOR, iconLinkHtml } from '../config/icons';
import type { ArticleRow } from '../db/rows';
import type { ArticleStatus } from '../jobs/types';

export interface LayoutOptions {
  title: string;
  active: 'dashboard' | 'import' | 'articles' | 'jobs';
  siteName: string;
  version?: string;
}

const NAV: Array<{ key: LayoutOptions['active']; href: string; label: string }> = [
  { key: 'dashboard', href: '/admin', label: 'Dashboard' },
  { key: 'import', href: '/admin/import', label: 'Import' },
  { key: 'articles', href: '/admin/articles', label: 'Articles' },
  { key: 'jobs', href: '/admin/jobs', label: 'Jobs' },
];

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
</head>
<body>
<header class="topbar">
  <div class="brand"><img class="brand-mark" src="/logo-mark.png" width="72" height="72" alt="" decoding="async"><img class="brand-mark brand-mark-inverse" src="/logo-mark-inverse.png" width="72" height="72" alt="" decoding="async">${escapeHtml(options.siteName)} <span class="brand-tag">admin</span></div>
  <nav class="nav">${nav}</nav>
  <div class="topbar-meta">Phase 1${options.version ? ` · ${escapeHtml(options.version)}` : ''}</div>
</header>
<main class="main">
${body}
</main>
</body>
</html>`;
}

// --- dashboard (SPEC §16.1) -----------------------------------------------

export interface DashboardView {
  total: number;
  articles: Record<string, number>;
  today: { imported: number; published: number; failed: number };
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

  return layout(
    { title: 'Dashboard', active: 'dashboard', siteName }, 
    `<h1>Dashboard</h1>
<p class="lede">Curation pipeline status. Import URLs to create articles; crawling starts in Phase 2.</p>
<div class="cards">${cards}</div>
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
    outcomes: Array<{ status: string; input: string; canonicalUrl?: string; articleId?: string; code?: string; message?: string }>;
  };
  error?: string;
}

export function importView(view: ImportView, siteName: string = FALLBACK_SITE_NAME): string {
  let banner = '';
  if (view.error) {
    banner = `<div class="banner banner-error">${escapeHtml(view.error)}</div>`;
  } else if (view.result) {
    const r = view.result;
    const tone = r.failed > 0 ? 'banner-warn' : 'banner-ok';
    banner = `<div class="banner ${tone}">
      <strong>Imported.</strong> ${r.created} created · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} · ${r.failed} rejected
    </div>`;

    const rows = r.outcomes
      .map(
        (o) => `<tr>
        <td><span class="pill pill-${o.status}">${escapeHtml(o.status)}</span></td>
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
  articles: ArticleListItem[];
  status: string | null;
  statuses: string[];
}

export function articleListView(view: ArticleListView, siteName: string = FALLBACK_SITE_NAME): string {
  const filter = view.statuses
    .map(
      (s) =>
        `<a class="chip${s === (view.status ?? '') ? ' is-active' : ''}" href="/admin/articles?status=${s}">${escapeHtml(s)}</a>`,
    )
    .join('');

  const rows = view.articles
    .map(
      (a) => `<tr>
      <td><span class="pill pill-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
      <td class="wrap"><a href="/admin/articles/${escapeHtml(a.id)}">${escapeHtml(a.title || a.canonical_url)}</a></td>
      <td>${escapeHtml(a.author_username ?? '—')}</td>
      <td class="num">${escapeHtml(new Date(a.imported_at).toISOString().replace('T', ' ').slice(0, 16))}</td>
      <td class="wrap"><a href="${escapeHtml(a.canonical_url)}" target="_blank" rel="noreferrer noopener">source</a></td>
    </tr>`,
    )
    .join('');

  const body = `<h1>Articles</h1>
<div class="chips">${filter}</div>
${
  view.articles.length === 0
    ? '<div class="card empty">No articles match this filter. <a href="/admin/import">Import some URLs</a> to get started.</div>'
    : `<table class="table">
  <thead><tr><th>Status</th><th>Title</th><th>Author</th><th class="num">Imported</th><th></th></tr></thead>
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

export function loginView(message?: string, siteName: string = FALLBACK_SITE_NAME): string {
  const banner = message ? `<div class="banner banner-error">${escapeHtml(message)}</div>` : '';
  const body = `<h1>Admin sign in</h1>
<p class="lede">Admin is protected by Cloudflare Access in production (SPEC §24). This form only
exists for local development, where you set the <code>ADMIN_TOKEN</code> secret.</p>
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

function ts(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}
