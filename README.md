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
scripts/               smoke.sh · smoke-site.sh · cleanup-smoke.sh
tests/unit/            156 tests
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
| Images | 9, in document order (the 10th capture image is the author chip, §7.2) |

### Media: the archive owns the bytes (SPEC §10)

Before this, every figure on the reading page was an `<img>` pointing at
`pbs.twimg.com`. That is not an archive — X deletes posts, replaces images on
reposts, and re-encodes media behind the same URL, so every hotlinked image was a
promise that someone else's storage decision would hold forever.

`POST /api/admin/articles/:id/media` (and the **Archive images** button) copies
every image into R2 under `articles/{id}/media/NNN.<ext>`. The reading page then
serves all of them from `/media/:imageId`, which reads the bytes from R2. The
byline avatar goes through the same pipeline, since it was the other X CDN
hotlink on the page.

Four decisions worth knowing about:

- **The extension follows the sniffed format, not SPEC §10's literal `.webp`.**
  X serves WebP when asked, but a response that ignored the `Accept` header would
  land PNG or JPEG bytes under a `.webp` name, and `/media` would then serve the
  wrong content type. The key is named after magic bytes, so `.webp` always holds
  WebP.
- **The content-type header is not trusted.** SPEC §10 asks for a content-type
  check, and the check is a magic-byte sniff instead: an HTML error page served as
  `image/jpeg` would otherwise be archived as an image and fail in the reader's
  browser instead of in the pipeline.
- **An image the pipeline gave up on is not hotlinked.** It renders as a labelled
  link to the original. A reader cannot tell a working image from one that breaks
  the day X drops it, so the page says which is which.
- **Image ids are scoped per article.** They hash the canonical URL *and* the
  image URL, because `media_objects.id` is the PRIMARY KEY and an author posting
  several articles has one avatar. Keying on the URL alone collided, and the
  second article's media run died on a UNIQUE violation.

The media job is enqueued by the parse job, not the crawl: media is derived from
the ArticleDocument, so there is no path that produces a document without also
scheduling its download. A failed image never fails its Article (SPEC §10) — it
becomes `failed` or stays `external_fallback`, and the admin detail page lists
every image with its status, dimensions and reason.

### R2 keys never lie about their contents (SPEC §8 / §10)

Every key the media pipeline writes is derived from the *sniffed* format, not from
the `content-type` header and not from a constant. `R2_PATHS.avatar` originally
hardcoded `.webp` while X serves the avatar as JPEG, so four objects sat in the
bucket as JPEG bytes under a WebP name. The pages still rendered — `/media` serves
the content type from D1 rather than from the key — which is exactly why the
mismatch survived so long.

Two consequences follow from the key being derived state, and both are handled:

- **A row whose key no longer matches its own position is stale.** A re-parse that
  reorders figures leaves keys pointing at another image's bytes. The run clears
  the key and re-downloads.
- **A key nothing claims is deleted.** Clearing `r2_key` only stops D1 pointing at
  the old key; the bytes stay in the bucket. Every media run sweeps the article's
  `media/` prefix and deletes anything the current rows do not claim, so a renamed
  key scheme or a reordered article does not accumulate copies. The expected set
  is derived entirely from D1, so the sweep is safe to run repeatedly.

`GET /api/admin/storage` reports R2 prefixes that no D1 row claims. SPEC §8 makes
raw append-only, so deleting an article row deliberately leaves its captures
behind — an archive is a record of what was captured. That means a smoke run
accrues prefixes, and without this endpoint they were invisible: 24 of them had
piled up unnoticed. They are reported, never auto-deleted, because nothing in the
Worker can tell a stale prefix from a capture whose row was restored on purpose.

### An Article's `/status/` permalink

X serves a long-form Article at two URLs, and the second is the one people copy:

```
https://x.com/<user>/article/<id>     the Article itself
https://x.com/<user>/status/<id>      the permalink of the post that announced it
```

Both are the same snowflake in the same id space, confirmed against a live capture.
The two are not interchangeable as pages: the `/status/` one renders a generic post
shell (`<author> on X: "https://t.co/..."`, with 9,350 visible characters of mostly
chrome), while `/article/` renders the Article (4,351 characters, clean
`og:title`). So `normalizeArticleUrl` accepts both and always rewrites the result
to the `/article/` form.

That rewrite is the whole design. `canonical_url` is UNIQUE (SPEC §5.3) and is the
dedup key, so both spellings collapse onto one row instead of importing the same
article twice, and the crawler is handed the URL that actually contains the content.
A test asserts the two spellings produce an identical canonical URL, id and handle.

A plain short post at `/<user>/status/<id>` is therefore also accepted, and it fails
later and more honestly: X serves its "page does not exist" for `/article/<id>`,
which the crawler reports as `ARTICLE_NOT_FOUND`. Probing first would cost a request
on every import and X is unreliable about that when logged out.

### Colour themes

The palette follows [aihot.news](https://aihot.news): a warm paper ground rather
than pure white, a deep teal accent instead of a bright blue, and four ink steps
instead of one. The dark theme is a separately chosen set of values, not an
inversion — an inverted palette lands on muddy greys. The accent keeps one hue
across both themes and changes only lightness, because the contrast ratio has to
work in both directions.

Three states, not a toggle: light, dark, and follow the system. "Follow the
system" has to be expressible, or a reader whose OS flips at sunset touches the
control twice every evening.

Three implementation choices carry the behaviour:

- **The switcher is radios, not buttons.** The selected state lives in the form
  and CSS does the highlighting with `:has(input:checked)`, so the control renders
  and responds before — and without — any script, and stays keyboard navigable.
  JavaScript only persists the choice.
- **The theme is applied by a synchronous inline script in `<head>`.** A deferred
  or module script runs after the first paint, which is exactly the
  white-flash-then-dark flash this exists to prevent: the stylesheet cannot know
  the reader's choice until something tells it.
- **A change repaints the page, and the paint is one shared function.** The first
  version persisted the choice and nothing else, on the assumption that the radio's
  `:checked` state plus CSS would follow. It does not: that rule only highlights the
  control. The theme is driven by `data-theme` on `<html>`, so clicking "dark" moved
  the highlight and left the page light until a reload. The attribute write, the
  `theme-color` tag and the OS listener now live in one `apply()` exposed as
  `window.__xahTheme`, and both the head script and the change handler call it —
  duplicating that logic across the two is what let them drift.
- **The choice is stored in both a cookie and `localStorage`, and the cookie
  wins.** `localStorage` is invisible to the server, so without the cookie the
  switcher would render in the `system` position on every page load even though
  the theme itself was right — which reads as the control not taking the click.

With scripting off, `data-theme` is never written and `prefers-color-scheme`
governs, so the page still respects the OS rather than pinning everyone to light.

`/admin` uses the same token names, so the two surfaces read as one product. It
had been carrying GitHub's dark palette, which meant the only thing the public
site and the admin shared was a logo. It follows the system scheme only — an
explicit override would need the inline script above, and there is no control on
that surface to express the choice.

One deliberate exception to theming: the logo tile stays a dark square with a light
X in both themes. A favicon cannot adapt to a colour scheme, so the in-page mark
inverting meant the same brand read two different ways depending on where you
looked.

`tests/unit/theme.test.ts` guards the properties that are easy to break silently:
both themes declare the same token set, the light values agree whether they come
from `:root` or `[data-theme='light']`, no colour is hard-coded outside the token
blocks, the apply script precedes `</head>`, the stored value is validated rather
than trusted, and the logo tile is theme-invariant.

### Icons

The mark is the favicon.io set: a black X folded from envelope flaps with a gold
star at the crossing. It ships as raster only — the 16px, 32px, 180px, 192px and
512px files are used as authored.

Three things about that set are load-bearing:

- **No `favicon.svg`.** A vector `rel="icon"` outranks every raster alternative, so
  shipping one would silently override the favicon.io files and none of their tuning
  would reach a browser. The small sizes are not downscales of the 512 — the 32px
  was drawn for its size, and the star is legible in it while a downscale loses it.
- **`sizes` is declared on every PNG.** Without it a browser may treat a PNG as
  scalable and pick the 512 for a 16px tab, which is the exact outcome the small
  files exist to prevent.
- **The Apple touch icon is flattened to no alpha.** iOS applies its own mask and
  draws transparency as black, so a touch icon that merely happens to be fully
  opaque still risks black corners. The shipped file has no alpha channel at all.

`safari-pinned-tab.svg` is traced from the 512 rather than redrawn, so it is
provably the same mark. Safari reads its alpha channel as a stencil and paints the
surviving shape in the user's own toolbar colour, so it is a flat silhouette with no
background, no gradient, and no fill colour of its own. The gold star is not
represented: at one bit it would either vanish or become a hole, and since Safari
tints the whole shape one colour, a cut-out star reads as a defect rather than a
seal. A test asserts every traced coordinate lands inside the viewBox, because SVG
clips silently and a centring slip shows up as a pinned tab with only the top of
the X and nothing reporting a problem.

The manifest lists no maskable icon. The artwork is a floating shape with no
full-bleed background, so an Android launcher cropping it to a circle would cut
into the glyph; claiming one anyway makes Chrome prefer it on install.

`THEME_COLOR` is a light paper tone rather than a saturated brand blue, because the
mark is near-black and a dark theme colour renders the icon invisible against the
browser chrome. A test asserts the theme colour is actually light, since a colour
that merely has the right format would pass a format check.

The link tags live in `src/config/icons.ts` rather than in either head template.
There are two independent heads — `src/layouts/Base.astro` for public pages and
the string template in `src/routes/views.ts` for `/admin` — and an admin page
showing a different icon than the article pages is exactly the kind of thing nobody
notices until it is wrong in a screenshot.

`/site.webmanifest` is server-rendered rather than a static file, so `name` and
`theme_color` track `SITE_NAME` the way `/robots.txt` tracks `SITE_ORIGIN`.
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
6. **`0005_media.sql`** adds `media_objects` (SPEC §10): one row per image with
   `position`, `source_url`, `r2_key`, `width`, `height`, `alt_text` and the
   `ready` / `failed` / `external_fallback` status. It also carries `kind`
   (`body` / `avatar`) so the author portrait does not take a body ordinal, plus
   `content_type`, `byte_size` and `error_code` — SPEC §25's
   `IMAGE_FETCH_FAILED` / `INVALID_CONTENT_TYPE` / `IMAGE_TOO_LARGE` need
   somewhere to land, and without them a permanently broken image is
   indistinguishable from a retryable one.
7. **`0006_media_job_type.sql`** adds `'media'` to `crawl_jobs.job_type`'s CHECK.
   The table was written against the five job types SPEC §19 named, and routing
   media through the existing `parse` type would make a redelivered parse message
   indistinguishable from a media one. SQLite cannot ALTER a CHECK, so the table
   is rebuilt with foreign keys deferred across the swap.
8. **`0004_parser_versions.sql`** changes `article_versions` from
   `UNIQUE(article_id, version)` (SPEC §11.6) to
   `UNIQUE(article_id, version, parser_version)`. §11.6's key cannot coexist with
   its own `parser_version` column: §27 requires a re-parse to produce a new
   ArticleDocument, and with a per-(article, version) key re-parsing failed with a
   UNIQUE violation. The new key satisfies §28 (unchanged *source* → no new row)
   and §27 (unchanged source, new *parser* → new row) at once.
9. **`0003_search.sql`** adds FTS5. §42 orders FTS5 at P4, but `/search` is part
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

Both scripts create articles, and SPEC §8 makes raw append-only, so each run
leaves an `articles/{id}/` prefix in R2 that no D1 row points at. That is correct
for real content and wrong for a fixture, so:

```bash
npm run cleanup -- https://x-article-hub.zachzhao.workers.dev "$TOKEN"
```

Both smoke scripts request HTTP/1.1 with `--retry-all-errors`. The edge
intermittently returns an HTTP/2 framing-layer error or resets the TLS connection,
and plain `--retry` covers neither — the suite was failing checks that had nothing
to do with what they test. Over HTTP/1.1 the same 60-request burst produces zero
failures. `--retry-all-errors` only widens the retry set for requests using `-f`,
and every check that asserts a rejection omits `-f` so it can read the status code,
so those are still issued exactly once.

`cleanup-smoke.sh` asks `GET /api/admin/storage` which prefixes are orphaned and
purges them via `POST /api/admin/maintenance/purge-prefix`, then re-checks that the
bucket is clean and exits non-zero if it is not. It purges the R2 prefix *before*
dropping the D1 row — the other order would leave the prefix behind on any failure
between the two, which is the state it exists to clean up.

The purge endpoint is guarded three ways, because an endpoint that deletes stored
captures is one bad id away from losing real content:

| Guard | Rejects |
|---|---|
| `articleId` must match `art_[a-z0-9]{16,32}` | A malformed id turning into a `articles/` or wider-prefix delete |
| `confirm` must repeat the id | A stray or replayed request |
| A live, non-fixture row is refused (403) | Real content — a published article can never become a teardown candidate |

A prefix with **no** D1 row is allowed, because that is the orphan case the
endpoint exists for: nothing in the application can reach it, since the reading
page, admin surface and search index all resolve an article from D1 first. It has
to be allowed, or cleanup could never run — a smoke run's D1 row is exactly what
gets deleted. A prefix with nothing stored in it returns 404 rather than reporting
a successful no-op. `smoke.sh` asserts every one of these.

### Admin actions on an article

| Action | Effect |
|---|---|
| `POST /api/admin/articles/:id/retry` | Re-publishes the queue message |
| `POST /api/admin/articles/:id/crawl` | Runs Browser Run immediately, reports the exact §25 code |
| `GET /api/admin/articles/:id/raw?format=html\|markdown` | The archived capture, not a live fetch |
| `POST /api/admin/articles/:id/parse` | Runs the Parser now. Reads only R2 — free, no X traffic |
| `GET /api/admin/storage` | R2 inventory: total objects/bytes, media by status, and prefixes no D1 row claims |
| `GET /api/admin/articles/:id/media` | Per-image status: archived, on x.com, or failed, with the reason |
| `POST /api/admin/articles/:id/media` | Downloads every image into R2. Re-run to retry failures |
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
