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

Astro  ── /  /featured  /latest  /trending  /rising  /category/:slug  /tag/:slug
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

### Search (SPEC §12)

Search worked for English and not for Chinese, and it did not look broken.

`articles_fts` is tokenised with SQLite's `unicode61`, which classifies a CJK ideograph
as an **alphanumeric** character. A run of Chinese with no whitespace between it is
therefore indexed as one token — the archived 美股 article contains the token
`一篇讲清楚美股入门的基本逻辑` — so a reader searching `投资` got nothing back even though the
word is in the body. `美股` worked, but only by luck: a `## 美股` heading happens to sit
alone in its own token.

| Query | Before | After |
| --- | --- | --- |
| `投资` | 0 | 2 |
| `编程` / `AI编程` | 0 | 1 |
| `暴涨`, `纳斯达克` | 0 | 1 |
| `美股入门` | 1 (a heading token) | 1 (anywhere in the body) |
| `Claude`, `claude code`, `ray_codeproxy` | 1 / 1 / 3 | unchanged |

The archive is mostly Chinese, so this was search failing for the language most of its
content is written in. It survived a phase because every check around it happened to pass
for the wrong reason: the acceptance check searched for `cache`, a Latin word, and every
test for `buildFtsQuery` was Latin too.

**The fix is segmentation, not a different tokenizer.** `src/lib/cjk.ts` puts a plain
space either side of every CJK character before indexing, so `unicode61` splits it into one
token per ideograph and Latin words are untouched. Kana and Hangul are included because
they break identically — a CJK-only fix would leave Japanese and Korean just as broken.
Verified against SQLite directly rather than assumed: a per-ideograph token list plus a
phrase query matches consecutive characters, and `"世 界 你 好"` does **not** match a body
reading `你好世界`.

Which is why the query builder had to change too. Two separate phrases, `"投" "资"`, are
an implicit AND in FTS5 and would be satisfied by an article mentioning 投 and 资 in
unrelated sentences — a search that invents a hit is worse than one that misses. A CJK word
becomes **one** phrase instead, `"投 资"`, meaning consecutive tokens in order. A reader
who types `你好世界` with no spaces gets that exact four-character run, which is what they
meant.

Two columns, treated differently on purpose:

- **`fts_content` and `fts_tags` were never `SELECT`ed anywhere.** They are SPEC §12's
  plain-text index field, read only by the trigger, so migration 0007 *renames*
  `content_text`/`tags_text` in place rather than copying a 9kB body per article. The
  rename also means nobody later mistakes the column for something to display.
- **`title`, `excerpt`, `author_name` and `author_username` are displayed**, so they keep
  their exact value and gain an `fts_` twin. The trigger reads
  `COALESCE(new.fts_title, new.title)`: a writer that forgets the twin degrades to today's
  behaviour rather than to an empty index.
  `tests/unit/cjk-search.test.ts` fails if any `UPDATE articles` sets one without its twin.

`scripts/backfill-search-index.mjs` fills the existing rows. It imports `segmentCjk` rather
than copying it — a copy in a script that runs against production is a copy that eventually
disagrees with the module the Worker imports, and the symptom is an index nobody can search
with nothing reporting why. It is idempotent and resumable, which matters because D1
refuses explicit SQL transactions: statements are applied without `BEGIN`/`COMMIT`, so a
partial run is finished by running it again, and it prints how many rows remain.

**One thing that looks like an improvement and is not.** `snippet(articles_fts, 3, …)`
addresses the content column by position. Changing it to the name — `snippet(articles_fts,
'fts_content', …)` — reads as more robust, and in this SQLite build the name does not
resolve: it silently falls back to column 0, the `UNINDEXED` article_id. Every result then
previewed as `art_7i7n5…` instead of the matching sentence, with no error and no failed
check. Both halves are pinned together now — the positional index *and* the column order in
migration 0007 — and the acceptance suite asserts that a search snippet is prose and not an
article id.

The `snippet()` output comes from the indexed text, so it carries the inserted spaces;
`deSegment` removes them on the way out. It steps over `<mark>` because the matched phrase is
wrapped in one, so `美 <mark>投 资</mark> 股` becomes `美<mark>投资</mark>股`. The honest
limitation is that segmented text cannot say whether a space was inserted or written, so a
genuine space beside an ideograph goes too — `美股 ETF` previews as `美股ETF`. A missing
space in a preview is the price; the alternative was an invisible separator character between
every ideograph of every stored body, unreadable in a `SELECT` and hostile to a future
`LIKE` fallback.

`Nvidia` still finds nothing, which is correct rather than a gap: those articles say 英伟达.

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

### Typography

The type stack is the one in the brief, with one thing added that the brief's
snippet does not need and this site does: the reading surface.

The CJK families are not an appendix. The archive is mostly Chinese, so they are
the primary rendering and Latin is the fallback *within* each family — `Inter` has
no CJK coverage, so it paints Latin only, and the browser skips a face that cannot
render a glyph and takes the next one per character. That is also why a locally
installed Inter changes the Latin text and leaves the Chinese alone, which is
correct. No webfont is loaded: the stack is a local-name lookup, so it costs
nothing when the face is absent and falls through to the OS.

Body prose is **16px / 1.75 in the sans family**, not the serif. `ui-serif`
resolves Chinese to Songti SC, whose hairline strokes go grey on a light ground
and muddy on a dark one; the archive is mostly Chinese, and a 17.5px reading
surface is most of the product. A PingFang / Noto Sans face keeps a consistent
stem weight and actually uses the 1.75. Serif is kept for one thing — the ranking
digit, where the contrast is a design choice and there is no CJK to clash with.

Two things that only surfaced by looking at the rendered result:

- **The leading had to be split, not just raised.** 1.75 on `body` cascaded to
  every 11–13px label and put them in 21px line boxes, which showed as a visible
  gap between a card title and its author. Prose gets 1.75; everything else gets
  1.5, and the reading surface is restated *after* that fallback so a bare `p`
  cannot win on source order. The restatement is load-bearing: with it in the
  wrong place, body text measured 26.25px instead of 30.6px, which is the exact
  leading the change was meant to fix. `:not(.article-body p)` also works but puts
  a compound selector inside `:not()`, i.e. Selectors 4, unsupported before
  Safari 16.
- **The headline tracking had to go.** `-0.03em` is tuned for Latin counters, and
  CJK glyphs already fill the em box, so tracking them in squeezes the ideographs
  together and reads as a rendering fault.

`tests/unit/typography.test.ts` covers the stack order, the reading-surface family
and leading, the split, the restatement's position, and that no small label is left
inheriting the prose leading. The two orderings were each verified to fail by
breaking them.

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

`/admin` uses the same token names and now the same control, so the two surfaces
read as one product and behave as one. It had been carrying GitHub's dark palette,
which meant the only thing the public site and the admin shared was a logo, and it
followed the system scheme alone — no switcher, so no choice to honour. The switcher
replaced a `Phase 1` label in the topbar's right-hand corner, which was a
build-milestone marker that meant nothing to an operator and was still being served
after the phase it referred to had been replaced.

Two surfaces render their own HTML — the public one through `Base.astro`, the admin
through string templates in `routes/views.ts` — so both need the same two scripts.
Copying them was the obvious move and the wrong one: the drift this section's last
bullet describes is exactly what a second copy looks like. They live in
`src/lib/theme.ts` as exported strings, injected by both surfaces, along with the
option list so the two controls cannot disagree about what the third option is
called. The scripts stay plain ES5 in a string rather than becoming a real
`<script type="module">`, because module scripts are deferred by definition and the
theme would land after the first paint.

The admin renders no `checked` attribute: the public pages get it from the cookie
through `Astro.cookies`, and threading it through seven view functions and their
seven call sites for a first-paint nicety was not worth it. A small admin-only
script puts the control where the page already is instead, reading `data-theme`
rather than the cookie — the attribute is what the page is painted from, so it is
the only source that cannot disagree with the surface. `admin.css` therefore needed
the same `:root:not([data-theme='light'])` scoping and `[data-theme='dark']` block
the public stylesheet has, without which a reader who chose light on a dark-mode
machine would get the dark palette in the admin and the light one everywhere else.

The brand mark adapts per theme on both surfaces — it is a near-black silhouette by
construction, so on the dark ground it is not low contrast, it is absent — and the
favicon ships a matching inverse so the tab adapts with the page.

`tests/unit/theme.test.ts` guards the properties that are easy to break silently:
both themes declare the same token set on both stylesheets, the light values agree
whether they come from `:root` or `[data-theme='light']`, no colour is hard-coded
outside the token blocks, the apply script is injected before `</head>` and is not a
module, the stored value is validated rather than trusted, the scripts are shared
rather than copied, and the brand mark follows the choice rather than only the
system scheme.

### Icons and the logo

The artwork is `Logo.jpg` at the repo root: a near-black X folded from envelope flaps
with a gold star at the crossing. Everything the site serves as a mark is generated
from that one file by `scripts/build-logo.py` — the tab icons, the touch icon, the
manifest icons, and the header mark. One source rather than a hand-tuned set, because
a hand-tuned set is how the 16px and the 512 end up being different logos.

The script exists because of something about the source file. `Logo.jpg` is a JPEG,
and a JPEG cannot hold transparency. The mark was exported over a grey/white
checkerboard, so **that checkerboard is real pixels in the file** — neutral, 209 to
254 in luminance, and therefore indistinguishable from a light background.

That was not hypothetical. Every icon the site shipped before was a transparent PNG
that still had the checkerboard baked in at full opacity, so browser tabs, iOS home
screens and Android launchers all drew a grey checkerboard around the mark. Nothing
about the files said so: they declared an alpha channel, which is the first thing any
reader checks.

**How the matte separates the mark.** On two independent axes, which is why no single
threshold works:

| part | luminance | chroma (R−B) |
| --- | --- | --- |
| the checker's darker square | 209 | 0 |
| the mark's body | 26–165 | 0 |
| the gold star | up to 246 | up to 94 |

The body is neutral and dark; the star is chromatic and bright. Thresholding on
luminance swallows the star, thresholding on chroma swallows the body's highlights,
so the rule is *chromatic **or** dark*. The artwork's brightest pixel (246) is also
one of its most chromatic (94), and those two conditions never overlap — that is
exactly why no single threshold can separate them.

Alpha is binary by design. Every output is at most 512px from a 1712px source, so the
silhouette is resampled by at least 3.4× on the way down, and Lanczos over a 1px-hard
edge produces the anti-aliased edge a soft matte would have given. What is lost is
sub-pixel *position* accuracy — at most ±1 source pixel, under 0.3px at the largest
output. A soft matte would buy nothing visible there and would cost a per-pixel solve
for a foreground colour the artwork does not have, since the body is a shaded gradient
rather than one flat value. One morphological step does the part that does matter: JPEG
chroma subsampling rings a half-tone transition along the edge, and a binary closing
removes that fringe.

Two details that are not cosmetic:

- **The mark is fitted to its larger side, not its width.** It is 809×887, taller than
  it is wide, so fitting to width leaves the small sizes with a mark so short that the
  folds and the star disappear — which is the entire reason a separate hand-tuned raster
  used to exist for 16px.
- **The touch icon's tile colour is read out of `src/config/icons.ts`**, not copied. An
  iOS icon cut from a different paper than the splash behind it reads as a rendering
  fault, and a second copy of the value is a second place to forget to update it.

### The mark inverts for dark surfaces

The mark is a near-black silhouette by construction, so on the dark ground it is not
low contrast, it is absent: measured against `#13191c` the body sits near a contrast
ratio of 1.1. Two rasters ship — `logo-mark.png` and `logo-mark-inverse.png` — and one
is shown per theme.

A CSS filter is not the answer. Inverting the gold star sends it through the
complement to teal, which on this palette *is* the accent colour, so the star would
read as interface rather than as artwork. Two files also mean the dark variant is the
same artwork rather than a filter's idea of it. The inverse maps the body's shading
along the site's own paper ramp — so the emboss survives as a gradient instead of
flattening — and leaves the star's hue alone, gaining only the headroom it loses
against dark ink. A test asserts the star is still chromatic in the inverse, because a
recolour that greys it out is the failure this shape invites.

The favicons get the same treatment via `media="(prefers-color-scheme: dark)"`, which is
the only way a raster can answer a dark tab bar. The alternative — baking a light tile
into the favicon — shows that tile's own edge against a white tab. A gated icon is
useless without an ungated twin, so both sizes ship twice and a test pairs them.

This reverses an earlier decision, and the reason is worth keeping: the mark used to be
a dark tile with a light letter, deliberately *unthemed* so it would keep matching a
favicon that could not adapt, because two ways to read one brand depending on where you
looked is worse than either. That premise is gone — the favicon now adapts with the
page, so tab and header agree in both themes and there is nothing left to hold still.

### What the icon tests actually check

`tests/unit/icons.test.ts` decodes pixels rather than reading the IHDR header, because
the header is not where this bug lives: the broken files were truecolour-with-alpha like
any other RGBA PNG, so a colour-type check called them fine. It walks the scanline
filters to find the minimum alpha, which is what distinguishes a matte from a baked-in
background. Verified by feeding it the old files: *"favicon-32x32.png is opaque
everywhere — a baked-in background, not a matte"*, plus a coverage of 100%.

The reader (`tests/unit/png.ts`) normalises to RGBA whatever the file stored, which is
not optional: the same pipeline writes the 16px favicon as a **paletted** PNG carrying
transparency in a `tRNS` table and the 180px one as truecolour with an alpha channel.
Forcing truecolour with `PNG32:` is ignored by ImageMagick, and the palette is lossless
and smaller anyway, so the reader handles both.

Other load-bearing properties, each asserted:

- **No `favicon.svg`.** A vector `rel="icon"` outranks every raster alternative, so
  shipping one would silently override the artwork and none of the generated sizes
  would reach a browser. `mask-icon` is a different rel and does not take part in that
  ranking, which is why the pinned tab stays.
- **`sizes` on every PNG.** Without it a browser may treat a PNG as scalable and pick
  the 512 for a 16px tab, which is the exact outcome the small files exist to prevent.
- **The touch icon has no transparent pixel.** iOS applies its own mask and draws
  transparency as black, so a transparent corner ships as a black corner. Asserted on the
  pixels rather than on the presence of an alpha channel, because a file may carry an
  alpha channel and still be opaque throughout.
- **The `.ico` still carries 16, 32 and 48.** The PNGs win in every current browser, so
  the `.ico` is only reached by a legacy one — and a stale `.ico` is invisible to every
  other check, because nothing in the document claims a size for it.

`safari-pinned-tab.svg` is traced from the artwork rather than redrawn, so it is
provably the same mark. Safari reads its alpha channel as a stencil and paints the
surviving shape in the user's own toolbar colour, so it is a flat silhouette with no
background, no gradient, and no fill colour of its own. The gold star is not
represented: at one bit it would either vanish or become a hole, and since Safari tints
the whole shape one colour, a cut-out star reads as a defect rather than a seal. A test
asserts every traced coordinate lands inside the viewBox, because SVG clips silently and
a centring slip shows up as a pinned tab with only the top of the X and nothing
reporting a problem.

The manifest lists no maskable icon. The artwork is a floating shape with no full-bleed
background, so an Android launcher cropping it to a circle would cut into the glyph;
claiming one anyway makes Chrome prefer it on install.

`THEME_COLOR` is a light paper tone rather than a saturated brand blue, because the mark
is near-black and a dark theme colour renders the icon invisible against the browser
chrome. A test asserts the theme colour is actually light, since a colour that merely
has the right format would pass a format check.

The link tags live in `src/config/icons.ts` rather than in either head template. There
are two independent heads — `src/layouts/Base.astro` for public pages and the string
template in `src/routes/views.ts` for `/admin` — and an admin page showing a different
icon than the article pages is exactly the kind of thing nobody notices until it is
wrong in a screenshot. `/site.webmanifest` is server-rendered rather than a static file,
so `name` and `theme_color` track `SITE_NAME` the way `/robots.txt` tracks `SITE_ORIGIN`.

### Navigation glyphs

Everything the interface draws as an icon is [Phosphor](https://phosphoricons.com)
(MIT, see `NOTICE.md`), vendored as path data in `src/icons/phosphor.ts` and inlined by
`src/components/Icon.astro`. Nine paths: six in the navigation, three in the theme
control.

**Vendored rather than a dependency**, for three reasons that each cost something
measurable:

- **No request.** Phosphor ships a webfont package too. It would add a blocking fetch
  and a flash of invisible icons in the header, which is the first thing on every page.
  Nine paths inline are about 2.6kB of HTML against a font file orders of magnitude
  larger.
- **No webfont.** This site loads no webfont at all — the type stack is entirely
  local-name lookups, because the archive is mostly Chinese and the CJK faces are the
  primary rendering. An icon font would be the single exception, for nine icons.
- **No drift.** These are the upstream 2.1.1 paths, byte for byte. A dependency upgrade
  could restyle the navigation between deploys; a vendored path cannot.

**Which icon, chosen against what each board orders by** — which is why two of them are
not interchangeable:

| Destination | Orders by | Glyph |
| --- | --- | --- |
| `/` | — | `house` |
| `/featured` | the editor's flag — not a score | `star` |
| `/latest` | `published_at DESC` — a question of *when* | `clock` |
| `/trending` | weighted blend — what is hot now | `fire` |
| `/rising` | `velocity_score` alone — a line going up | `trend-up` |
| `/authors` | — | `users` |

`/search` and `/about` are not in this table because they are not in the navigation any
more — they were removed from it, not from the site. `/search` is still what the header's
search box submits to and `/about` is still linked from the footer.

`/trending` and `/rising` diverge by design (§ the four boards), and one shared icon
would erase that from the navigation — the one place a reader looks to find out which
one they are on. A test asserts the two are never given the same glyph.

`trend-up` rather than `chart-line-up` is a deliberate trade: a chart icon has more
visual mass and balances the row better, but the site has no chart page, and an icon
that implies a destination which does not exist is a worse fault than one that reads a
shade light. At 18px the diagonal is perfectly legible — diagonals lose apparent weight
at small sizes whatever the icon, so a heavier arrow would lose it just as much.

**The current page is the theme switch's own selected treatment** — an `--accent` fill
with `--accent-contrast` lettering — so the accent means one thing across the site: you
are here. It replaces `background: var(--panel-2)`, which on the header measured a
contrast ratio of **1.06** in the light theme and **1.21** in the dark one. That is not
subtle; a reader could not tell which board they were on. The accent fill measures 5.9:1
against the header in light and 9.0:1 in dark, with 6.2:1 and 10.7:1 between its own fill
and its own lettering.

Two details that are decisions rather than taste. The active state repeats itself on
`:hover`, because the hover rule sets a background and would otherwise knock the fill off
the current page the moment a pointer crossed it — the same class of fault as the theme
switch that once persisted a choice and repainted nothing. And there is **no**
`font-weight` change, though `.cat-chip.active` uses one: weight widens the label, the
nav has no slack (seven items at 10px padding need exactly the 642px the row has from
1200px up), and a bolder current item would change the row's width on every navigation.

Hover stays neutral so the accent keeps meaning one thing — it is carried by the
lettering, `--muted` 5.7:1 against the header versus `--text` at 13.9:1, with
`--panel-2` as a faint raised surface behind it.

The category chips below the nav answer the same question with a `--text` fill, and the
two never appear together: the nav has no `/category/*` entry and `isActive` matches on a
path prefix, so a category page activates no nav item and a board page activates no chip.
A test asserts both halves, because adding a category entry to the nav would put a
near-black pill 60px below an accent one.

**Weight is regular, size is per call site** — 18px in the navigation beside 14px
labels, 15px in the segmented control where the box is fixed. Regular and bold are
barely distinguishable at those sizes, and regular sits more quietly beside the text.
Sizes were compared at 16/18/20px against the real header: 16px reads a shade small
next to 14px text, 20px starts to dominate the label.

**One fill model.** Every Phosphor icon in the set is a single closed path on the
`0 0 256 256` grid, filled with `currentColor`. `thin` and `light` are the two weights
drawn with strokes instead, and mixing one in would render nothing under a fill-only
renderer. Because the colour comes from `currentColor`, the glyphs follow the theme and
the active state with no second rule — measured on the deployed page: `rgb(89,101,107)`
in light and `rgb(165,176,179)` in dark, both exactly the theme's `--muted`.

**The theme control moved too.** Its three icons were hand-written paths on a 24 grid,
stroked, sitting about 400px from the navigation's glyphs — two icon systems with two
grids and two fill models in one 58px-tall bar. They are `sun`, `moon` and `desktop`
now, on the same grid. `desktop` is the machine that holds the preference, which is
what "follow the system" means.

Two things `tests/unit/glyphs.test.ts` guards that would otherwise fail *quietly*:

- **A stylesheet cannot blank a filled glyph.** The theme rule used to be
  `fill: none; stroke: currentColor` for its stroked icons. A CSS declaration beats an
  SVG presentation attribute, so leaving that behind when swapping in filled paths
  renders all three options as blank squares inside a still-clickable radio group — and
  no markup-level test sees it, because the markup is correct and only the cascade
  decides. Verified by reintroducing the rule.
- **`flex: none` on the nav glyphs.** The nav is `overflow-x: auto` so it can scroll on
  a narrow screen, and a flex item defaults to shrinking — without this the six icons
  deform before any label moves.

`IconName` is a union of the vendored keys, so a name that was never vendored is a
compile error rather than an empty box beside a readable label. The tests then cover
what types cannot: that every nav destination has an icon, that nothing is vendored and
unused, that no literal Unicode glyph is left standing in for one, and that provenance
and licence are recorded in `NOTICE.md` — vendored geometry is the kind of thing that
gets "tidied" by someone who assumes it was drawn in-house.
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

## The four boards are genuinely different

SPEC §15 requires four boards that do not collapse into one ordering:

| Board | Ordering | Top 3 (demo set) |
|---|---|---|
| `/featured` | `featured = 1`, then `published_at DESC` | Agents, Market |
| `/latest` | `published_at DESC` | Database → Inference → Market |
| `/trending` | `final_score DESC` (weighted blend) | Agents → Inference → Market |
| `/rising` | `velocity_score DESC` **only** | Agents → Inference → Database |

`/rising` ranks "Reading Slowly" above "Measurement Noise" while `/trending`
reverses them — that divergence is the point of keeping velocity separate from the
blend (§14.2). Weights come from `RANKING_WEIGHTS_JSON`, never from a literal in
code (§14.4).

Editor's Pick is not a fifth ranking. `SORT_SQL.featured` is `published_at DESC`
and mentions no score, so on the ordering alone `/featured` would be a copy of
`/latest`; what makes it a board is a `WHERE` clause — `if (sort === 'featured')
where.push('a.featured = 1')` in `src/db/public.ts`. That is worth stating
because it is the one piece of this table a refactor of the sort map alone could
lose without any test noticing.

It is the only board an editor curates rather than a machine ranking, so it is
named differently at each layer: the URL and the nav label are `/featured` and
**Featured**, while the page heading and the homepage's lead row are **Editor's
Pick**, which is also the wording on the badge a featured card carries. One
concept, two lengths — the short one where horizontal space is scarce.

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

The logo assets in `public/` are committed, but they are *generated*: after changing
`Logo.jpg`, regenerate them rather than editing the PNGs, since a direct edit is
overwritten on the next run.

```bash
python3 scripts/build-logo.py       # needs `magick` on PATH and numpy
```

It rewrites every icon and header mark in `public/` from `Logo.jpg` alone, so the
source is the only thing to edit. Writing a reader that decodes those files — rather
than trusting their headers — is what surfaced the two things this section's format
claims were wrong: the encoder produces a **paletted** 16px favicon (correct and
smaller, but a reader that only knows an alpha channel calls it opaque), and it
produced a **16-bit** touch icon until the sample depth was pinned.

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
| `PATCH /api/admin/articles/:id` | §16.3 editor overrides: `categoryId`, `summary`, `displayMode` |

### The category control, and the gap it came from

Every article on the site sat in **no** category for the length of a phase, and every
header chip read `0`. The cause was not the count query, and not the join:

- `articles.category_id` has **no writer** in `src/` outside the demo seeder.
- `ai_category`, the column an AI suggestion would land in, has no producer — AI
  enrichment is Phase 4 and does not exist. `src/services/crawl.ts` says so in its own
  comment, which is why a crawl hands the article straight to `review`.
- `overrideCategory` existed the whole time and was reachable through
  `PATCH /api/admin/articles/:id` — and the admin page had no control for it.

So the columns were genuinely NULL and `COALESCE(editor_category_id, category_id)`
correctly resolved to nothing. The fix is a `<select>` on the article page posting to a
new `POST /admin/articles/:id/category`, calling the service that was already there.

Three things that were easy to get wrong:

- **A plain form, not a fetch.** The rest of this surface is forms precisely so it works
  without scripting. A control that needs JavaScript is a control that silently does
  nothing for anyone who disabled it. It also inherits Astro's same-origin CSRF check
  for free — a POST without a matching `Origin` never reaches the Worker.
- **The empty value clears the override** rather than storing a category called `""`.
  `editor_category_id` has no foreign key and every read joins through it, so a bogus
  value is invisible: the article reappears as uncategorised and the `category_override`
  audit event names a category that does not exist. `resolveCategoryOverride` therefore
  validates against the live list, and an unknown id is a 400 with the id named. The
  same guard covers the API path, which had the hole too.
- **The picker states where the value came from.** It shows the effective category — the
  same `COALESCE` precedence every read uses — and says whether that is your override,
  a direct assignment, or an accepted AI suggestion. A picker that shows a value without
  saying which column supplied it is how an editor "fixes" something that was never
  wrong. A stored id that matches no category is shown as "— none —" and named as stale,
  rather than rendered as a selection.

`tests/unit/curation-actions.test.ts` holds the generalisation: **every exported action
in `publish.ts` is either reachable from a surface or on a reviewed exception list with a
reason**, and **every `POST /articles/:id/*` route has a form**. Both directions failed
when the feature was removed, which is the run that proves the guard is not vacuous.

The same sweep found two things this change does not fix, listed so they are not lost:

- **`overrideSummary` has the identical gap** — API only, no form. One control to add.
- **`restoreArticle` is a dead export.** Nothing calls it anywhere; `restoreDisplay` is
  what the Restore button uses.

And the scores are still absent, which is the larger gap: `applyRankingScores` has zero
callers and no cron is registered, so `final_score` and `velocity_score` are NULL and
`/latest`, `/trending` and `/rising` currently return **identical orderings**. The "four
boards are genuinely different" table further up holds for the demo set only.

`/featured` is the exception and it does diverge, because its filter is `featured = 1` and
not a score: three of the five live articles are flagged, so it returns three rows while
the other three boards return five.

The five published articles were categorised through the new form once it shipped —
three AI, one Technology, one Business, judged from each article's own content rather
than its title alone. `Jev Search` is the one judgement call: its subject is an
open-source project, which `Technology`'s description names explicitly, though it is
framed against AI-generated search answers.

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

⚠️ **`ADMIN_TOKEN` 是 wrangler secret，永远不要写进仓库。** 2026-10-13 轮换过一次：
它曾是 8 位的 `12345678`，且作为默认值散落在 5 个脚本里 —— 那正是把它变成公开仓库
就会泄露的形状。现在是 48 位随机值，存在 `.dev.vars`（已被 `.gitignore` 排除），
脚本一律从 `$ADMIN_TOKEN` 读且**没有回退默认值**，缺失时直接报错退出。轮换：

```bash
openssl rand -hex 24 | npx wrangler secret put ADMIN_TOKEN
```

`devtoken` 是 smoke 脚本的本地默认值，生产上返回 401，不是凭据。

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
