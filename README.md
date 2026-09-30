# X Article Hub

A human-curated, machine-archived library of X Articles — built entirely on Cloudflare.

Implements **SPEC §38 Phase 0–3**: infrastructure, human import, the real Browser
Run crawl, and the Parser — plus the public reading site (§17), ranking (§14),
full-text search (§12), SEO (§33) and content governance (§37).

- **Live:** https://x-article-hub.zachzhao.workers.dev
- **Admin:** https://x-article-hub.zachzhao.workers.dev/admin

"> ✅ **Real X Article bodies are readable logged-out.** Verified against a live
> article (10 602 chars captured, no cookies configured). See
> [X access](#x-access) — including the cases that *do* look like walls.

---

## What works today

```text
Admin paste URLs
      ↓
Hono  ── normalize (§5.2) ── dedup (§5.3)
      ↓
D1     ── article + crawl_job + curation_event
      ↓
Queues ── article-ingest ──▶ crawl consumer
                              ↓
                        Browser Run /snapshot      (§7)
                        one session → HTML + Markdown
                              ↓
                        R2 raw archive             (§8)
                        + source/content hash       (§27, §28)
                              ↓
                        metadata → D1, status=review
                        (published articles stay published)
                              ↓
                     Queues ── article-process ──▶ Parser
                                                   raw/page.md → ArticleDocument
                                                   (§9 — no X traffic, no browser time)
                                                   ↓
                                    versions/vN/article.json → R2
                                    content_text → D1 → FTS5

Astro  ── /  /latest  /trending  /rising  /category/:slug  /tag/:slug
          /author/:username  /article/:slug  /search  /about
          /sitemap.xml  /robots.txt  /feed.xml
```

### Verification status

| Check | Count | Command |
|---|---:|---|
| Unit tests (url, ranking, config, document, crawl recognition, parser, state machine) | 129 | `npm test` |
| Phase 1 acceptance | 44 | `npm run smoke -- <url> <token>` |
| Public-site acceptance | 63 | `npm run smoke:site -- <url> <token>` |
| TypeScript strict | clean | `npm run typecheck` |

All suites pass against the live deployment. The crawl was verified end to end
against **live X** and a live content page — see [Crawl verification](#crawl-verification).

---

## Crawl verification

The crawl was exercised against real Browser Run responses, not mocks.

| Scenario | Result |
|---|---|
| Real content page (Cloudflare docs) | `archived`, 14 820 chars, HTML 152 KB + Markdown 15 KB in R2, title + avatar extracted |
| Same page re-crawled (§28) | `unchanged` — no second version created |
| Re-crawl of a **published** article | stays `published`, never un-published by a background job |
| Nonexistent X article | `ARTICLE_NOT_FOUND`, nothing archived |
| **Real X Article (logged out, no cookies)** | `archived`, 10 602 chars, HTML 133 KB + Markdown 26 KB, title/author extracted |
| Profile page / walled capture | `LOGIN_REQUIRED`, nothing archived, operator told what to do |
| Browser Run 429 | `PAGE_BLOCKED` + `rateLimited` flag → 1 h backoff instead of the §25 ladder |
| Queue consumer path (real import) | `pending → fetching → failed`, delivered once, correct non-retryable code |

### Three findings that shaped the implementation

**1. `/snapshot` instead of `/markdown` + `/content`.** Two separate quick
actions cost two browser sessions. `/snapshot` with
`formats: ["content", "markdown"]` returns both in **one**: measured 1 794 ms and
one `X-Browser-Ms-Used` for a full capture versus 2 596 ms and two calls. This is
not an optimisation — the second call was being rate-limited, and the missing HTML
failed *silently*, producing an archive the Phase 3 Parser could not use. HTML
capture failure is now reported on the crawl outcome (`htmlError`).

**2. Only *some* X pages are walls — do not generalise from one.** A real Article
page served its full body logged-out with no cookies configured. But a *profile*
page and a *nonexistent* Article URL both come back as login walls. Recognising
that difference matters, so the classifier checks for X's own "this page doesn't
exist" marker *before* the login-wall heuristic — otherwise a deleted article
would be misreported as `LOGIN_REQUIRED` and sent to an operator to fix cookies
for an article that simply does not exist.

**3. Browser Run rate limits are tight on this account.** Repeated 429s during
development. A rate-limited crawl now backs off **1 hour** rather than following
the §25 ladder's 1-minute first step, which would just burn quota faster.

---

## X access

**Real X Articles are readable logged-out.** A live article
(`x.com/HaibaraCrypto/article/2103788150405705870`) was captured in full — 10 602
characters of body, 133 KB of rendered HTML, 26 KB of Markdown, with title, author
and publish date extracted — with **no cookies configured at all**.

What *is* walled, logged-out:

| Page | What X returns |
|---|---|
| A profile (`x.com/<user>`) | login wall |
| A **nonexistent** article | login wall **and** X's own "this page doesn't exist" |

The distinction is what the classifier keys on. It checks for X's explicit
404 marker first, then the login wall, so a deleted article reports
`ARTICLE_NOT_FOUND` and a genuinely walled capture reports `LOGIN_REQUIRED`.

If a private or subscriber-only article ever does need a session: X uses cookie
sessions, not HTTP Basic auth, so the documented `authenticate` quick-action
option **cannot** log in. The only mechanism Browser Run offers is `cookies`
(Puppeteer `setCookie` objects).

```bash
# 1. Sign in to x.com in a real browser.
# 2. Copy the document.cookie values for auth_token and ct0 from x.com.
# 3. Store them as Puppeteer cookie objects:
npx wrangler secret put X_COOKIES_JSON -c dist/server/wrangler.json
```

```json
[
  { "name": "auth_token", "value": "…", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "ct0", "value": "…", "domain": ".x.com", "path": "/", "secure": true }
]
```

The cookie is never logged and never returned by an endpoint. Treat it as a
password: it grants access to a real X account. **Leave it unset unless a
specific article turns out to be private** — it is not needed for ordinary
articles, and not having it keeps the crawl inside the least-privilege path.

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
worker.route('/', apiApp); // /api/*, /admin/*, /healthz  (Hono)
worker.all('/api/*', apiNotFound); // JSON 404 before Astro can answer with HTML
worker.use(pages());     // public reading site (Astro, SSR)
worker.use(i18n());
```

A custom entrypoint (`main: ./src/worker.ts`) is required because the adapter's
default entrypoint cannot export the `queue` / `scheduled` handlers (§19 / §21).

### Layout

```text
src/
  worker.ts            Worker entry: fetch / queue / scheduled      (§31)
  app.ts               Hono sub-app: /api/*, /admin/*, /healthz
  middleware.ts        Astro cache policy                          (§23)
  pages/               Astro public site                           (§17)
  layouts/ components/ Base.astro, SiteHeader, ArticleCard, BoardPage
  config/              site · ranking weights (§14) · AI (§32)
  db/                  rows · articles · jobs · events · public · stats · categories
  jobs/                types (§19) · dispatch · crawl (§2) · x-selectors (§7.4)
  lib/                 url (§5) · ids · hash · logger (§35) · errors (§25) · http
  ranking/score.ts     popularity · velocity · normalize · combine  (§14)
  services/            import (§5) · crawl (§7) · browser (§7) · publish (§6/§37) · archive · seed-demo
  types/               ArticleDocument (§9) + R2 path layout (§8)
  routes/              public-api · admin-api · admin-ui · views
migrations/            0001_init · 0002_seed_categories · 0003_search (§12)
scripts/               smoke.sh · smoke-site.sh
tests/unit/            93 tests
public/                admin.css · site.css
```

---

## Error handling (SPEC §25)

Every crawl ends in exactly one typed code, and the codes stay distinguishable —
SPEC §25 explicitly requires that timeout types are not collapsed into "fetch
failed".

| Code | Meaning | Retryable |
|---|---|---|
| `FETCH_TIMEOUT` | Browser Run could not load the page in time | yes (§25 ladder) |
| `PAGE_BLOCKED` | 429 / 403 / other block — includes our own quota | yes (**1 h** if rate-limited) |
| `PARSER_FAILED` | Captured, but HTML→Markdown conversion failed (Browser Run code 2012) | yes |
| `ARTICLE_NOT_FOUND` | X served its own 404, or 404/410 from Browser Run | **no** |
| `EMPTY_CONTENT` | Deleted, private, or empty | **no** |
| `LOGIN_REQUIRED` | X served its logged-out shell | **no** — set cookies first |

Retry ladder is §25's: 1 min → 5 min → 30 min → 2 h → 24 h, then `failed`.

---

## The Parser (SPEC §9)

`raw → ArticleDocument → D1`, verified against a real capture
(`tests/fixtures/x-article-2103788150405705870.md`, the verbatim `/markdown`
output for a published X Article).

**It parses Markdown, not the rendered HTML.** SPEC §7.2 names metadata and media
mapping as `/markdown`'s weakness — not structure. The rendered X DOM is a React
tree whose selectors break when the site changes (SPEC §26 item 3), while the
Markdown already encodes the author's own headings, quotes, lists, code fences and
image order deterministically. §26's ladder starts at "semantic selector"; Markdown
is that, without the fragility.

| Result on the fixture | |
|---|---:|
| Blocks | 249 |
| Paragraphs | 209 |
| Headings | 32 (levels preserved, clamped to 1–3 per §9.2) |
| List items | 18 across 3 lists |
| Quotes | 1 |
| Images | 10, in document order |
| Links | 15 |
| Warnings | 0 |

Acceptance (SPEC §39 Parser): title ✓ author ✓ date ✓ paragraphs ✓ images ✓ links ✓

**SPEC §27 is the point of this phase.** Because raw output is kept, re-parsing is
a local operation over R2: bumping `PARSER_VERSION` and re-running fixes every
article without spending Browser Run time or asking X for anything. A re-parse with
an unchanged parser version is a no-op (`unchanged`), which is what makes the queue
consumer idempotent per SPEC §19.

Four bugs the fixture tests caught, all invisible on synthetic input:

- **An infinite loop.** The duplicate-title skip did `continue` without advancing
  the line index. Harmless while the condition never matched; it hung the Worker
  the moment it did. Found by running the parser standalone against the fixture,
  not by a unit test — the suite simply timed out.
- **CJK word counts.** Whitespace tokenisation made a 10,610-character Chinese
  article 436 "words", understating both the AI input budget and the reading time
  by ~5×. Each CJK ideograph now counts as one word.
- **Nested lists were silently restructured.** A `-` child under an ordered `1.`
  flushed the parent list and became a sibling. Nesting is now read from the raw
  line's indentation before the marker-kind switch, flattened into the parent, and
  reported as a warning — because silently reshaping a list is a data change.
- **Handles kept their original case.** `HaibaraCrypto` and `haibaracrypto` are
  the same author, and the dedup key is lowercased; the Parser now agrees.

---

## The three boards are genuinely different

SPEC §15 requires four boards that do not collapse into one ordering:

| Board | Ordering | Top 3 (demo set) |
|---|---|---|
| `/latest` | `published_at DESC` | Database → Inference → Market |
| `/trending` | `final_score DESC` (weighted blend) | Agents → Inference → Market |
| `/rising` | `velocity_score DESC` **only** | Agents → Inference → Database |
| Editor's Pick | `featured = true` (human) | Agents, Market |

`/rising` ranks "Reading Slowly" above "Measurement Noise" while `/trending`
reverses them — that divergence is the point of keeping velocity separate from the
blend (§14.2). Weights come from `RANKING_WEIGHTS_JSON`, never from a literal in
code (§14.4).

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
republish the full text".

---

## Demo content

There is no real published content yet, because reading a real X Article needs a
session (see above). To make the product verifiable,
`src/services/seed-demo.ts` writes 6 clearly-fictional articles that exercise
every code path: blocks, headings, quotes, tags, topics, two metric samples (so
velocity is computable), all five categories, and real §14 scores.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://<host>" \
  https://x-article-hub.zachzhao.workers.dev/api/admin/demo/seed
```

Identifiable and removable: authors are `demo_*`, `x_article_id`s start with `9000`,
every curation event is noted `DEMO CONTENT`, and `demo/clear` deletes exactly that
set.

---

## Schema deviations from SPEC §11

All deliberate; all additive or justified by the spec's own later sections.

1. **`articles.title` has `DEFAULT ''`.** §11.4 says `NOT NULL`, but a row is
   created at import time, before any crawl produces a title (§6: `imported`
   precedes `fetching`). The provisional title is replaced by the crawl.
2. **Raw captures are timestamped directories.** §8's directory listing is
   "recommended", but its rule is explicit: "Raw 永远只追加，不覆盖". A fixed
   `raw/page.html` cannot satisfy both, so each capture gets
   `articles/{id}/raw/{timestamp}/` and `metadata.json` names its own siblings.
   `articles.raw_r2_key` stays one stable pointer per article.
3. **`slug`, `featured`, `display_mode`, `takedown_*`, `word_count`, `block_count`,
   `content_text`, `tags_text`** added up front — required by §15, §17.1, §37, §12.
4. **`crawl_jobs.deliveries` / `last_delivered_at`** for the queue observability
   §35 requires, and to make the Phase 1 → Phase 2 boundary observable.
5. **Partial unique index `idx_crawl_jobs_open_per_type`** — one open job per
   (article, job_type), which is what makes retry idempotent (§19).
6. **`0003_search.sql`** adds FTS5. §42 orders FTS5 at P4, but `/search` is part
   of the reading experience and §12 says D1's FTS5 is sufficient — no
   Elasticsearch.

### One spec conflict, resolved

§6 lists `queued` as an article state but the recommended `articles.status` enum
omits it, while §22's import example returns `"status": "queued"`. Resolution:
`articles.status` uses the §6 enum (`pending` is the import state),
`crawl_jobs.status` owns `queued`, and the import response's `status` field
reports the **job** status — both sections satisfied.

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

```bash
npm run smoke      -- http://127.0.0.1:8787 devtoken
npm run smoke:site -- https://x-article-hub.zachzhao.workers.dev "$TOKEN"
```

`smoke.sh` covers the Phase 1 pipeline plus the browser login flow.
`smoke-site.sh` covers routes, styled 404s, board divergence, SEO, cache headers,
search, SPEC §37 governance and public-API shape.

### Admin actions on an article

| Action | Effect |
|---|---|
| `POST /api/admin/articles/:id/retry` | Re-publishes the queue message |
| `POST /api/admin/articles/:id/crawl` | Runs Browser Run immediately, reports the exact §25 code |
| `GET /api/admin/articles/:id/raw?format=html\|markdown` | The archived capture, not a live fetch |
| `POST /api/admin/articles/:id/parse` | Runs the Parser now. Reads only R2 — free, no X traffic |
| `GET /api/admin/articles/:id/errors` | Job errors straight from the job row |
| `POST /api/admin/articles/:id/takedown` | §37 takedown (requires a reason) |

---

## Cloudflare resources

| Binding | Resource | Notes |
|---|---|---|
| `DB` | D1 `x-article-hub` | `61f1e63b-4097-49fb-a99d-1f05dcb69ad9` |
| `ARCHIVE` | R2 `x-article-archive` | raw captures + versioned documents (§8) |
| `BROWSER` | Browser Run | `remote: true` — Quick Actions need it |
| `AI` | Workers AI | bound, used from Phase 4 |
| `ARTICLE_INGEST_QUEUE` | Queue `article-ingest` | crawl consumer + `article-ingest-dlq` |
| `ARTICLE_PROCESS_QUEUE` | Queue `article-process` | consumer |
| `ARTICLE_METRICS_QUEUE` | Queue `article-metrics` | producer only until Phase 6 |
| `ASSETS` | Workers static assets | `site.css`, `admin.css`, `/_astro/*` |

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | §24 dev shim. Replace with Cloudflare Access. |
| `X_COOKIES_JSON` | Optional. Only for private/subscriber articles. See [X access](#x-access). |

| Var | Purpose |
|---|---|
| `RANKING_WEIGHTS_JSON` | §14.4 — weights are configurable, never hard-coded |
| `MAX_IMPORT_URLS` | §16.2 guard against pasting a whole file |
| `CRAWL_SCREENSHOT` | §39 optional screenshot capture, default `false` |

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

⚠️ The currently-set `ADMIN_TOKEN` is 8 characters and trivially guessable. Rotate
it: `npx wrangler secret put ADMIN_TOKEN -c dist/server/wrangler.json`.

---

## Known platform behaviour

**Cloudflare applies CSRF protection to Workers.** A POST without a same-origin
`Origin` header is rejected with `403 Cross-site POST form submissions are
forbidden` before the Worker runs. Browsers always send `Origin` on a same-origin
form POST, so the admin UI is unaffected — scripted clients must send it.
`scripts/smoke.sh` does, and asserts the 403 as a security property.

---

## Phase 4 next steps

1. **Media** (§10): download images to `articles/{id}/media/NNN.webp`. They are
   currently `external_fallback` — rendered from X's CDN with
   `referrerpolicy="no-referrer"`. §10 requires the front end not to depend on X's
   URLs, and it also makes the archive self-sufficient. A failed image must not
   fail the article.
2. **Workers AI** (§4): summary, category suggestion, tags, quality. `AI_CONFIG`
   exists but nothing calls it yet. Schema validation and the editor override are
   already in place (§4.7), and the `/review` board is waiting for content.
3. **Metrics** (§14): popularity and velocity need real engagement numbers, which
   are not collected yet — the demo set has seeded values so the boards are not
   empty.
