# X Article Hub

A human-curated, machine-archived library of X Articles — built entirely on Cloudflare.

This repository implements **SPEC §38 Phase 0 (基础设施) + Phase 1 (人工导入)** of
[`x-article-curated-site-development-spec.md`](./x-article-curated-site-development-spec.md).

- **Live:** https://x-article-hub.zachzhao.workers.dev
- **Admin:** https://x-article-hub.zachzhao.workers.dev/admin

---

## What works today

```text
Admin paste URLs
      ↓
Hono  ── normalize (§5.2) ── dedup (§5.3)
      ↓
D1     ── article + crawl_job + curation_event
      ↓
Queues ── article-ingest ──▶ consumer
```

| Phase 1 acceptance (SPEC §38) | Status |
|---|---|
| 粘贴 URL | done — batch, multiline, comma/semicolon, `text/plain` or JSON |
| 自动去重 | done — `canonical_url` UNIQUE, plus in-batch dedup |
| 创建 Job | done — `crawl_jobs` row + `article-ingest` message |
| 返回 Article ID | done — `{ id, status: "queued" }` per SPEC §22 |
| Import 不同步等待 Crawl (§34) | done — returns after D1 writes + one `sendBatch` |

Infrastructure from **Phase 0** is live: D1, R2, all three Queues (+ DLQ), the
Browser Run binding, the Workers AI binding and `npm run deploy` all work.

---

## Deliberate scope boundaries

Crawling is **Phase 2** and is not implemented. The queue consumer receives the
message, records the delivery (`deliveries`, `last_delivered_at`) and leaves the
job `running`. It does **not** pretend to succeed. The admin UI shows this state
honestly, and Retry still applies (SPEC §25).

Likewise, these are absent rather than stubbed, because a `501` endpoint is worse
than a missing one:

| Missing | Why | Lands in |
|---|---|---|
| Browser Run crawl + R2 raw archive | largest technical risk, needs real URL fixtures first | Phase 2 |
| Parser → `ArticleDocument` | needs raw HTML to exist | Phase 3 |
| Publish / reject / review endpoints | nothing to review until parsing works | Phase 3 |
| Workers AI enrichment | needs parsed text | Phase 4 |
| FTS5 table, `/search`, `/trending`, `/rising` | needs content + scores | Phase 4, Phase 6 |
| Public reading site (Astro), sitemap, RSS | needs published articles | Phase 5 |

**Astro is deferred from Phase 0** to Phase 5. Spec §38 Phase 0 lists it, but at
Phase 1 there are no public pages, so it would add a second build pipeline and a
routing seam with zero output. The Worker already serves `/` from `public/` as a
placeholder, so Phase 5 is "add Astro behind the same Worker", not "rebuild".

---

## Schema deviations from SPEC §11

All deliberate; all additive or justified by the spec's own later sections.

1. **`articles.title` has `DEFAULT ''`.** SPEC §11.4 says `NOT NULL`, but an
   article row is created at *import* time, before any crawl has produced a
   title (SPEC §6: `imported` precedes `fetching`). A provisional
   `@username on X` is written and the Parser replaces it in Phase 3.
2. **`slug`, `featured`, `display_mode`, `takedown_*`, `word_count`, `block_count`
   added up front.** Required by SPEC §15 (Editor's Pick), §17.1 (`/article/:slug`)
   and §37 (governance). Adding them now avoids `ALTER TABLE` churn later.
3. **`crawl_jobs.deliveries` / `last_delivered_at` added** for the queue
   observability SPEC §35 requires, and to make the Phase 1 → Phase 2 boundary
   observable (produced vs. delivered vs. executed).
4. **Partial unique index `idx_crawl_jobs_open_per_type`** — one open job per
   (article, job_type), which is what makes retry idempotent (SPEC §19).
5. **No FTS5 table.** SPEC §42 orders FTS5 at P4, after the content it indexes.

### One spec conflict, resolved

SPEC §6 lists `queued` as an article state but the recommended `articles.status`
enum omits it, while SPEC §22's import example returns `"status": "queued"`.
Resolution: `articles.status` uses the §6 enum (`pending` is the import state) and
`crawl_jobs.status` owns `queued`. The import response's `status` field reports
the **job** status, so both sections are satisfied.

---

## Layout

SPEC §29's "single developer" compressed layout.

```text
src/
  index.ts            Worker entry: fetch / queue / scheduled   (§31)
  app.ts              Hono assembly + error handling
  env.ts              Binding types
  config/             site · ranking weights (§14) · AI (§32)
  db/                 rows.ts + articles · jobs · events · categories · stats
  lib/                url (§5) · ids · hash · logger (§35) · errors (§25) · http
  middleware/         admin-auth (§24)
  routes/             public-api · admin-api · admin-ui · views
  services/import.ts  the import pipeline (§5)
  jobs/               types (§19) · dispatch · ingest
migrations/           0001_init · 0002_seed_categories
scripts/smoke.sh      Phase 1 acceptance check
tests/                url + config unit tests
public/               admin.css, placeholder landing
```

---

## Development

```bash
npm install
cp .dev.vars.example .dev.vars     # set ADMIN_TOKEN for local admin access
npm run db:migrate:local
npm run dev                         # http://127.0.0.1:8787
```

```bash
npm run typecheck
npm test
npm run deploy:dry                  # validate build + bindings without uploading
npm run db:migrate:remote
npm run deploy
```

### Acceptance check

`scripts/smoke.sh` runs the SPEC §38 Phase 1 acceptance criteria against any
running Worker. It generates fresh article ids per run, so it is safe to re-run
against a database that already has data.

```bash
./scripts/smoke.sh                                                  # local dev
./scripts/smoke.sh https://x-article-hub.zachzhao.workers.dev <token> # deployed
```

34 checks: normalization, dedup, rejection codes, queue round-trip, retry
semantics, admin auth, and `no-store` on admin responses.

---

## Cloudflare resources

| Binding | Resource | Notes |
|---|---|---|
| `DB` | D1 `x-article-hub` | `61f1e63b-4097-49fb-a99d-1f05dcb69ad9` |
| `ARCHIVE` | R2 `x-article-archive` | bound now, written from Phase 2 |
| `BROWSER` | Browser Run | `remote: true` — Quick Actions need it |
| `AI` | Workers AI | bound now, used from Phase 4 |
| `ARTICLE_INGEST_QUEUE` | Queue `article-ingest` | consumer + `article-ingest-dlq` |
| `ARTICLE_PROCESS_QUEUE` | Queue `article-process` | consumer |
| `ARTICLE_METRICS_QUEUE` | Queue `article-metrics` | producer only until Phase 6 |
| `ASSETS` | Workers static assets | `/admin.css`, placeholder `/` |

Ranks are configured, not hard-coded (SPEC §14.4):

```jsonc
// wrangler.jsonc → vars
"RANKING_WEIGHTS_JSON": "{\"popularity\":0.4,\"velocity\":0.3,\"quality\":0.2,\"editor\":0.1}"
```

`src/config/ranking.ts` parses it, drops unusable entries and renormalizes to sum
to 1. The scoring itself is Phase 6.

---

## Admin security

SPEC §24 says not to implement admin auth yourself — put it behind Cloudflare
Access. `src/middleware/admin-auth.ts` therefore does only two things:

1. trusts `Cf-Access-Authenticated-User-Email` (i.e. Access already ran), and
2. accepts an `ADMIN_TOKEN` for local dev and `curl`.

There is no user table, no password store and no real session system. The
`/admin/login` cookie is a dev shim around the shared token.

**Next step before real use:** create an Access application in front of
`admin.<your-domain>` (SPEC §24), then delete the `ADMIN_TOKEN` secret:

```bash
wrangler secret delete ADMIN_TOKEN
```

A bootstrap token is currently set so the deployed admin is reachable and
testable. Rotate it any time with `wrangler secret put ADMIN_TOKEN`.

---

## Content governance

SPEC §37 applies from the first migration: `display_mode`
(`full` / `excerpt` / `link_only` / `takedown`), `takedown_requested_at`,
`takedown_reason`, and a `curation_events` audit trail. Admin `Takedown` /
`Archive` / `Restore` endpoints arrive with Phase 3's publish workflow.

Reaching "we crawled it" is not treated as "we may publish the full text"
permanently; the display policy is a data field, so it can be changed per
article without a redeploy.

---

## Phase 2 next steps

1. **De-risk the crawl first** (SPEC §42 calls this the biggest risk): take ~20
   real X Article URLs and run them through `BROWSER.quickAction('markdown')`,
   then build a fixture dataset from the results.
2. Implement `jobs/crawl.ts` using SPEC §7's two-level fallback
   (`/markdown` → `/content` → Parser → Browser Session), with all X selectors
   in one file (`src/jobs/x-selectors.ts`) per SPEC §7.4.
3. Archive raw output to `articles/{id}/raw/page.{html,md}` per SPEC §8, and
   record `browser_ms_used` from the `X-Browser-Ms-Used` header (SPEC §35).
4. Map failures to SPEC §25's codes (`FETCH_TIMEOUT`, `PAGE_BLOCKED`,
   `EMPTY_CONTENT`, `LOGIN_REQUIRED`, …) — Browser Run reports page-load,
   selector and action timeouts separately, and they must not collapse into
   one generic failure.
