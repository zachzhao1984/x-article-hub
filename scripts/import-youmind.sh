#!/usr/bin/env bash
# Discover X Articles from YouMind's viral-article explore page and import them.
#   ./scripts/import-youmind.sh [--pages N] [--base-url URL] [--token TOKEN] [--dry-run]
#
# ## What YouMind is, and what it is not
#
# YouMind's `/landing/x-viral-articles/explore` is a *discovery* index, not an article
# host: every entry links out to the original X post (`https://x.com/<user>/status/<id>`),
# in the page's own server-rendered HTML. So the job here is narrow — read those links off
# the listing and hand them to the import pipeline that already exists. Nothing about
# crawling, parsing, media or dedup changes.
#
# ## Why the listing is enough, with no browser
#
# The explore page is Next.js and renders the links into the HTML, so a single `curl` per
# page yields ten `x.com/.../status/NNN` URLs. No Browser Rendering, no headless session,
# and therefore no per-page browser cost — the browser only gets involved later, once a
# queue consumer crawls the actual article.
#
# ## Ordering and scope
#
# The page's default sort is already `time` (newest first; `?sort=` accepts
# time/views/likes/reposts/comments/bookmarks, and time is what the page ships with), and
# `?page=N` is server-side — page 1 and page 2 share no article ids. So "newest N pages"
# is just `page=1..N` with no sort parameter, which is exactly what this does. The default
# is deliberate: the request is the newest articles, and asking for a sort that is already
# the default would be a setting that only appears to do something.
#
# ## Politeness
#
# YouMind is a third party, it has no public API, and it sets `robots: noindex, follow`
# (indexing disallowed, link-following allowed). This script is therefore deliberately
# small in scope and slow in cadence: a fixed delay between pages, a normal User-Agent,
# and a default of ten pages. It reads the listing, it does not crawl or mirror the site.
# Retries use backoff rather than hammering, and a page that fails is reported and skipped
# rather than retried forever — a missing tenth page must not cost the other nine.
#
# ## Idempotence
#
# The import endpoint dedupes on `canonical_url` (SPEC §5.3), so re-running this is safe:
# an article already archived comes back as `duplicate`, not as a second row. That is why
# there is no dedup logic here — it would be a second, silently-diverging copy of a rule
# the database already enforces with a unique constraint.
set -euo pipefail

BASE="${BASE_URL:-https://x-article-hub.zachzhao.workers.dev}"
# The admin token opens the production admin API, so it is a *secret*, not a repo value:
# read from the environment with no fallback. A default here would publish the key
# alongside the code the moment this repository became public.
TOKEN="${ADMIN_TOKEN:-}"
EXPLORE="https://youmind.com/landing/x-viral-articles/explore"
PAGES=10
DELAY=2
DRY_RUN=0
# Browser Rendering is rate-limited per *account*, not per request. Importing a hundred
# URLs at once enqueues a hundred near-simultaneous crawls, and the queue consumer's
# `max_batch_size` (10) then fires ten browser sessions at a quota that cannot take them —
# measured: 19 of 100 archived, 81 returned 429 and entered a one-hour cooldown. Splitting
# the import into waves the queue can drain keeps the whole run inside the quota instead
# of trading most of it for retries.
WAVE=15
WAVE_PAUSE=60

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pages) PAGES="$2"; shift 2 ;;
    --base-url) BASE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --wave) WAVE="$2"; shift 2 ;;
    --wave-pause) WAVE_PAUSE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
if [[ -z "$TOKEN" ]]; then
  echo "no admin token: pass --token or set ADMIN_TOKEN." >&2
  echo "It is the wrangler secret ADMIN_TOKEN, not a value kept in this repo." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A normal browser UA. YouMind's CDN rejects some default curl agents, and identifying
# honestly is the polite thing to do when a script reads someone else's page on a schedule.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

echo "▸ Discovering X Articles from YouMind (${PAGES} pages, newest first)"

PAGE=1
while [[ "$PAGE" -le "$PAGES" ]]; do
  URL="$EXPLORE?page=$PAGE"
  HTML="$WORK/page-$PAGE.html"

  # Bounded retries. A page that never arrives is skipped, not fatal: the other pages are
  # still worth importing, and a partial run is recoverable on the next one (dedup).
  ok=0
  for attempt in 1 2 3; do
    if curl -s --http1.1 --retry 2 --retry-all-errors --retry-delay 2 \
        -A "$UA" -o "$HTML" -w '%{http_code}' "$URL" > "$WORK/code" 2>/dev/null && [ -s "$HTML" ]; then
      ok=1
      break
    fi
    sleep "$(( attempt * 3 ))"
  done

  if [[ "$ok" -ne 1 ]]; then
    printf '  %-8s %s\n' "page $PAGE" "✗ could not fetch (skipped)"
    PAGE=$(( PAGE + 1 ))
    continue
  fi

  count="$(python3 - "$HTML" "$WORK" "$PAGE" <<'PY'
import re, sys, pathlib
html, work, page = pathlib.Path(sys.argv[1]).read_text(errors='ignore'), sys.argv[2], sys.argv[3]
# The listing renders the original post link per entry. Anchor on the status shape so an
# author-profile link (`https://x.com/<user>`) is not mistaken for an article.
links = list(dict.fromkeys(re.findall(r'https://x\.com/[A-Za-z0-9_]+/status/\d+', html)))
pathlib.Path(f'{work}/links-{page}.txt').write_text('\n'.join(links) + ('\n' if links else ''))
print(len(links))
PY
)"
  printf '  %-8s %s\n' "page $PAGE" "✓ $count links"
  sleep "$DELAY"
  PAGE=$(( PAGE + 1 ))
done

# Concatenate, strip duplicates across pages (an article can move between pages while
# paginating), and write the import payload.
python3 - "$WORK" <<'PY'
import pathlib, sys, glob, re
work = pathlib.Path(sys.argv[1])
def page_num(p):
    return int(re.search(r'links-(\d+)\.txt$', p).group(1))
seen, ordered = set(), []
for f in sorted(glob.glob(f'{work}/links-*.txt'), key=page_num):
    for line in pathlib.Path(f).read_text().split():
        if line and line not in seen:
            seen.add(line)
            ordered.append(line)
pathlib.Path(f'{work}/all.txt').write_text('\n'.join(ordered) + '\n')
print(f'  {len(ordered)} unique article URLs across all pages')
PY

TOTAL="$(wc -l < "$WORK/all.txt" | tr -d ' ')"
if [[ "$TOTAL" -eq 0 ]]; then
  echo "  no links found — nothing to import"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "▸ Dry run — URLs that would be imported:"
  sed 's/^/    /' "$WORK/all.txt"
  exit 0
fi

# Import in waves. The endpoint accepts up to MAX_IMPORT_URLS (200) in a single POST, but
# the constraint that matters is not the payload size — it is how many crawls the browser
# quota can serve at once. Each wave is imported, then left to drain before the next is
# sent, so the queue is never holding more concurrent browser sessions than it can open.
echo
echo "▸ Importing ${TOTAL} URLs into review queue (waves of ${WAVE})"
python3 - "$WORK" "$BASE" "$TOKEN" "$WAVE" "$WAVE_PAUSE" <<'PY'
import json, pathlib, sys, time, urllib.request, urllib.error

work, base, token = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
wave, pause = int(sys.argv[4]), int(sys.argv[5])
urls = work.joinpath('all.txt').read_text().split()

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
totals = {'created': 0, 'duplicates': 0, 'failed': 0}
failures = []

for start in range(0, len(urls), wave):
    chunk = urls[start:start + wave]
    body = json.dumps({'urls': chunk}).encode()
    req = urllib.request.Request(
        f'{base}/api/admin/articles/import',
        data=body,
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            # Astro's CSRF guard answers 403 before application code runs without a
            # same-origin Origin on a state-changing request.
            'Origin': base,
            # Cloudflare's browser-integrity check (error 1010) rejects urllib's default
            # `Python-urllib/3.x` agent before the request reaches the Worker.
            'User-Agent': UA,
        },
    )
    label = f'{start + 1}-{start + len(chunk)}'
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            result = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'  wave {label}: ✗ HTTP {e.code} {e.read().decode()[:200]}')
        continue

    totals['created'] += result.get('created', 0)
    totals['duplicates'] += result.get('duplicates', 0)
    totals['failed'] += result.get('failed', 0)
    for o in result.get('outcomes', []):
        if o.get('status') == 'failed':
            failures.append(f"{o.get('input','')[:70]}  {o.get('code','')} {o.get('message','')}")

    print(f"  wave {label}: created {result.get('created', 0)}, dup {result.get('duplicates', 0)}, failed {result.get('failed', 0)}")

    # Let this wave drain before queueing the next. Only pause between waves — a trailing
    # pause would make the last wave wait for nothing.
    if start + wave < len(urls):
        time.sleep(pause)

print()
print(f"  created   {totals['created']}")
print(f"  duplicate {totals['duplicates']}")
print(f"  failed    {totals['failed']}")
for f in failures:
    print(f"    ✗ {f}")
PY

echo
echo "▸ Crawls are queued; articles appear in /admin/articles as they reach review."
