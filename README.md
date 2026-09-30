# X Article Hub

A human-curated, machine-archived library of X Articles — built entirely on Cloudflare.

Implements **SPEC §38 Phase 0 (基础设施) + Phase 1 (人工导入)**, plus the **public
reading site (SPEC §17)**, **ranking (SPEC §14)**, **full-text search (SPEC §12)**,
**SEO (SPEC §33)** and **content governance (SPEC §37)**.

- **Live:** https://x-article-hub.zachzhao.workers.dev
- **Admin:** https://x-article-hub.zachzhao.workers.dev/admin

> The crawl itself is **Phase 2 and not implemented**. Published content is
> clearly-labelled demo data — see [Demo content](#demo-content) below.

---

## What works today

```text
Admin paste URLs
      ↓
Hono  ── normalize (§5.2) ── dedup (§5.3)
      ↓
D1     ── article + crawl_job + curation_event
      ↓
Queues ── article-ingest ──▶ consumer  (records delivery; crawl is Phase 2)

Astro  ── /  /latest  /trending  /rising  /category/:slug  /tag/:slug
          /author/:username  /article/:slug  /search  /about
          /sitemap.xml  /robots.txt  /feed.xml
```

### Verification status

| Check | Count | Command |
|---|---:|---|
| Unit tests (url, ranking, config, document) | 70 | `npm test` |
| Phase 1 acceptance | 44 | `npm run smoke -- <url> <token>` |
| Public-site acceptance | 63 | `npm run smoke:site -- <url> <token>` |
| TypeScript strict | clean | `npm run typecheck` |

All three suites pass against the live deployment.

---

## Architecture

One Worker serves everything. Astro and Hono coexist through the Cloudflare
adapter's first-class Hono pipeline — the existing API routes slot in between
`middleware()` and `pages()` rather than being reimplemented:

```ts
// src/worker.ts
worker.use(cf());        // env + executionCtx, serves static assets
worker.use(actions());
worker.use(middleware()); // Astro middleware (src/middleware.ts → cache policy)
worker.route('/', apiApp); // /api/*, /admin/*, /healthz  (Hono, Phase 1)
worker.all('/api/*', apiNotFound); // JSON 404 before Astro can answer with HTML
worker.use(pages());     // public reading site (Astro, SSR)
worker.use(i18n());
```

A custom entrypoint (`main: ./src/worker.ts`) is required because the adapter's
default entrypoint cannot export the `queue` / `scheduled` handlers (SPEC §19 / §21).

### Layout

```text
src/
  worker.ts            Worker entry: fetch / queue / scheduled      (§31)
  app.ts               Hono sub-app: /api/*, /admin/*, /healthz
  middleware.ts        Astro cache policy                          (§23)
  env.ts               Ambient binding augmentation
  pages/               Astro public site                           (§17)
  layouts/ components/ Base.astro, SiteHeader, ArticleCard, BoardPage
  config/              site · ranking weights (§14) · AI (§32)
  db/                  rows · articles · jobs · events · public · stats · categories
  lib/                 url (§5) · ids · hash · logger (§35) · errors (§25) · http
  ranking/score.ts     popularity · velocity · normalize · combine  (§14)
  services/            import (§5) · publish (§6/§16.3/§37) · archive (§8) · seed-demo
  types/               ArticleDocument (§9) + R2 path layout (§8)
  routes/              public-api · admin-api · admin-ui · views
migrations/            0001_init · 0002_seed_categories · 0003_search (§12)
scripts/               smoke.sh · smoke-site.sh
public/                admin.css · site.css
```

---

## The three boards are genuinely different

SPEC §15 requires four boards that do not collapse into one ordering. With the
demo set:

| Board | Ordering | Top 3 |
|---|---|---|
| `/latest` | `published_at DESC` | Database → Inference → Market |
| `/trending` | `final_score DESC` (weighted blend) | Agents → Inference → Market |
| `/rising` | `velocity_score DESC` **only** | Agents → Inference → Database |
| Editor's Pick | `featured = true` (human) | Agents, Market |

`/rising` ranks "Reading Slowly" above "Measurement Noise" while `/trending`
reverses them — that divergence is the point of keeping velocity separate from
the blend (SPEC §14.2). Weights come from `RANKING_WEIGHTS_JSON`, never from a
literal in code (SPEC §14.4).

---

## Content governance (SPEC §37)

`display_mode` (`full` / `excerpt` / `link_only` / `takedown`) is enforced in
`src/db/public.ts` and verified by `smoke-site.sh`:

| Action | List / boards | Sitemap / RSS / search | Article page |
|---|---|---|---|
| `full` | visible | indexed | body rendered |
| `excerpt` | visible | indexed | notice, no body |
| `link_only` | visible | indexed | notice + X link, no body |
| `takedown` | hidden | hidden | **explains itself, shows reason, no body / no JSON-LD / no X link** |

A takedown returns **200 with an explanation**, not a 404 — a shared link should
not silently look broken. Reaching "we crawled it" is never treated as "we may
republish the full text" (SPEC §37).

---

## Demo content

The crawl pipeline is Phase 2, so there is nothing real to publish. To make the
product verifiable, `src/services/seed-demo.ts` writes 6 clearly-fictional
articles that exercise every code path: blocks, headings, quotes, tags, topics,
two metric samples (so velocity is computable), all five categories, and real
SPEC §14 scores.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://<host>" \
  https://x-article-hub.zachzhao.workers.dev/api/admin/demo/seed

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://<host>" \
  https://x-article-hub.zachzhao.workers.dev/api/admin/demo/clear
```

It is identifiable and removable: authors are `demo_*`, `x_article_id`s start
with `9000`, every curation event is noted `DEMO CONTENT`, and `demo/clear`
deletes exactly that set. **None of it is crawled content, and none of it proves
the crawl works.**

---

## Schema deviations from SPEC §11

All deliberate; all additive or justified by the spec's own later sections.

1. **`articles.title` has `DEFAULT ''`.** §11.4 says `NOT NULL`, but a row is
   created at import time, before any crawl produces a title (§6: `imported`
   precedes `fetching`). A provisional `@username on X` is written and the Parser
   replaces it in Phase 3.
2. **`slug`, `featured`, `display_mode`, `takedown_*`, `word_count`, `block_count`,
   `content_text`, `tags_text`** added up front. Required by §15, §17.1, §37, §12.
3. **`crawl_jobs.deliveries` / `last_delivered_at`** added for the queue
   observability §35 requires, and to make the Phase 1 → Phase 2 boundary
   observable (produced vs. delivered vs. executed).
4. **Partial unique index `idx_crawl_jobs_open_per_type`** — one open job per
   (article, job_type), which is what makes retry idempotent (§19).
5. **`0003_search.sql`** adds FTS5. §42 orders FTS5 at P4, but `/search` is part
   of the reading experience being delivered now, and §12 says D1's FTS5 is
   sufficient — no Elasticsearch.

### One spec conflict, resolved

§6 lists `queued` as an article state but the recommended `articles.status` enum
omits it, while §22's import example returns `"status": "queued"`. Resolution:
`articles.status` uses the §6 enum (`pending` is the import state),
`crawl_jobs.status` owns `queued`, and the import response's `status` field
reports the **job** status — so both sections are satisfied.

---

## Development

```bash
npm install
cp .dev.vars.example .dev.vars     # ADMIN_TOKEN for local admin access
npm run db:migrate:local
npm run dev                         # astro dev (workerd via the CF vite plugin)
```

```bash
npm run typecheck
npm test
npm run deploy:dry
npm run db:migrate:remote
npm run deploy                      # astro build && wrangler deploy -c dist/server/wrangler.json
```

`astro build` emits `dist/client` (assets) and `dist/server` (the Worker), and
generates `dist/server/wrangler.json` with `main` and `assets` already rewritten.
That generated file is what gets deployed — do not point `wrangler deploy` at
`wrangler.jsonc` directly.

### Acceptance checks

Both scripts take a base URL and token, and can be re-run against the same
database.

```bash
npm run smoke      -- http://127.0.0.1:8787 devtoken
npm run smoke:site -- https://x-article-hub.zachzhao.workers.dev "$TOKEN"
```

`smoke.sh` covers the Phase 1 pipeline plus the browser login flow.
`smoke-site.sh` covers routes, styled 404s, board divergence, SEO, cache
headers, search, SPEC §37 governance, and public-API shape.

---

## Cloudflare resources

| Binding | Resource | Notes |
|---|---|---|
| `DB` | D1 `x-article-hub` | `61f1e63b-4097-49fb-a99d-1f05dcb69ad9` |
| `ARCHIVE` | R2 `x-article-archive` | holds `ArticleDocument` JSON + Markdown per §8 |
| `BROWSER` | Browser Run | `remote: true` — Quick Actions need it |
| `AI` | Workers AI | bound now, used from Phase 4 |
| `ARTICLE_INGEST_QUEUE` | Queue `article-ingest` | consumer + `article-ingest-dlq` |
| `ARTICLE_PROCESS_QUEUE` | Queue `article-process` | consumer |
| `ARTICLE_METRICS_QUEUE` | Queue `article-metrics` | producer only until Phase 6 |
| `ASSETS` | Workers static assets | `site.css`, `admin.css`, `/_astro/*` |

---

## Admin security

§24 says not to implement admin auth yourself — put it behind Cloudflare Access.
`src/middleware/admin-auth.ts` does only two things:

1. trusts `Cf-Access-Authenticated-User-Email` (Access already ran), and
2. accepts a shared `ADMIN_TOKEN` for local dev and `curl`.

A successful token login sets a cookie holding `HMAC-SHA256(ADMIN_TOKEN)`:
verifiable, unforgeable without the secret, and not the token in the clear.

**Next step before real use:** put `admin.<your-domain>` behind an Access
application, then delete the shim:

```bash
wrangler secret delete ADMIN_TOKEN
```

⚠️ The currently-set `ADMIN_TOKEN` is 8 characters and trivially guessable. It
exists so the deployed admin is reachable during this build-out. Rotate it:

```bash
npx wrangler secret put ADMIN_TOKEN -c dist/server/wrangler.json
```

---

## Known platform behaviour

**Cloudflare applies CSRF protection to Workers.** A POST without a same-origin
`Origin` header is rejected with `403 Cross-site POST form submissions are
forbidden` before the Worker runs. Browsers always send `Origin` on a same-origin
form POST, so the admin UI is unaffected — but scripted clients must send it.
`scripts/smoke.sh` does, and asserts the 403 as a security property.

---

## Phase 2 next steps

1. **De-risk the crawl first.** §42 calls this the biggest risk. Browser Run works
   (verified against a non-X page), but **X's logged-out pages are a login wall**
   — so this almost certainly needs `BROWSER.quickAction` with
   `authenticate-username` / `authenticate-password`, i.e. §7.4 Level 3, plus real
   Article URLs to build fixtures from. Get a handful of real URLs and X
   credentials before writing parser code.
2. Implement `jobs/crawl.ts` with §7's two-level fallback
   (`/markdown` → `/content` → Parser → Browser Session), all X selectors in one
   file (`src/jobs/x-selectors.ts`) per §7.4.
3. Archive raw output to `articles/{id}/raw/page.{html,md}` per §8, and record
   `browser_ms_used` from `X-Browser-Ms-Used` (§35).
4. Map failures to §25's codes (`FETCH_TIMEOUT`, `PAGE_BLOCKED`, `EMPTY_CONTENT`,
   `LOGIN_REQUIRED`, …). Browser Run reports page-load, selector and action
   timeouts separately — they must not collapse into one generic failure.
5. Then Parser (§3) and Workers AI (§4). The `ArticleDocument` contract they must
   produce is already defined and the reading page already renders it.
