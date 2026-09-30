#!/usr/bin/env bash
# Public-site acceptance check (SPEC §17, §23, §33, §37).
#   ./scripts/smoke-site.sh [base-url] [admin-token]
#
# Run scripts/smoke.sh first; this assumes at least one published article exists.
# Use POST /api/admin/demo/seed to create some.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
TOKEN="${2:-${ADMIN_TOKEN:-devtoken}}"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
ORIGIN=(-H "Origin: ${BASE}")

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
contains() { if echo "$2" | grep -qF "$3"; then pass "$1"; else fail "$1 (missing '$3')"; fi; }
absent() { if echo "$2" | grep -qF "$3"; then fail "$1 (unexpectedly found '$3')"; else pass "$1"; fi; }

jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "▸ Public site acceptance against ${BASE}"

# --- seed so there is something to verify ----------------------------------
curl -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/demo/seed" > /dev/null

SLUG="$(curl -fsS "${BASE}/api/articles?limit=1" | jqv '.articles[0].slug')"
ID="$(curl -fsS "${BASE}/api/articles?limit=1" | jqv '.articles[0].id')"
if [ -z "$SLUG" ] || [ "$SLUG" = "undefined" ]; then
  fail "no published articles found — seed failed"
fi
echo "  (verifying against ${SLUG})"
echo

echo "Routes (SPEC §17.1)"
for p in / /latest /trending /rising /search /about /sitemap.xml /robots.txt /feed.xml; do
  check "GET ${p} renders" "$(status "${BASE}${p}")" "200"
done
check "GET /category/ai renders" "$(status "${BASE}/category/ai")" "200"
check "GET /tag/agents renders" "$(status "${BASE}/tag/agents")" "200"
check "GET /author/demo_karpathy renders" "$(status "${BASE}/author/demo_karpathy")" "200"
check "GET /article/:slug renders" "$(status "${BASE}/article/${SLUG}")" "200"

echo
echo "Unknown slugs return a styled 404, not a blank body"
for p in /article/nope /category/nope /tag/nope /author/nope; do
  check "GET ${p} is 404" "$(status "${BASE}${p}")" "404"
  # no -f: curl must be willing to return a 404 body here.
  contains "GET ${p} renders the 404 page" "$(curl -sS "${BASE}${p}")" "404 — not found"
done

echo
echo "Boards order differently (SPEC §15)"
LATEST="$(curl -fsS "${BASE}/latest")"
TRENDING="$(curl -fsS "${BASE}/trending")"
RISING="$(curl -fsS "${BASE}/rising")"
check "trending order differs from latest" \
  "$(if [ "$LATEST" != "$TRENDING" ]; then echo yes; else echo no; fi)" "yes"
check "rising order differs from trending" \
  "$(if [ "$TRENDING" != "$RISING" ]; then echo yes; else echo no; fi)" "yes"

echo
echo "SEO (SPEC §33)"
ARTICLE="$(curl -fsS "${BASE}/article/${SLUG}")"
contains "article has a canonical" "$ARTICLE" "<link rel=\"canonical\""
contains "article has og:title" "$ARTICLE" "property=\"og:title\""
contains "article has twitter:card" "$ARTICLE" "name=\"twitter:card\""
contains "article has JSON-LD" "$ARTICLE" "application/ld+json"
contains "article description is non-empty" "$ARTICLE" 'name="description"'
contains "admin pages are noindex" "$(curl -fsS "${AUTH[@]}" "${BASE}/admin")" 'name="robots" content="noindex'
ROBOTS="$(curl -fsS "${BASE}/robots.txt")"
contains "robots disallows /admin" "$ROBOTS" "Disallow: /admin"
contains "robots disallows /api" "$ROBOTS" "Disallow: /api/"
contains "robots points at the sitemap" "$ROBOTS" "Sitemap:"
SITEMAP="$(curl -fsS "${BASE}/sitemap.xml")"
contains "sitemap lists the article" "$SITEMAP" "/article/${SLUG}"
FEED="$(curl -fsS "${BASE}/feed.xml")"
contains "feed lists the article" "$FEED" "/article/${SLUG}"

echo
echo "Canonical points at the archive, not at X (SPEC §33)"
contains "article links to the original on X" "$ARTICLE" "View original on X"

echo
echo "Search (SPEC §12)"
SEARCH="$(curl -fsS "${BASE}/search?q=cache")"
contains "search returns results with snippets" "$SEARCH" "result-snippet"
check "search with no query renders the prompt" "$(status "${BASE}/search")" "200"

echo
echo "Cache policy (SPEC §23)"
cache_of() { curl -sI "$@" | tr -d '\r' | grep -i '^cache-control:' | head -1; }
contains "homepage sets s-maxage=60" "$(cache_of "${BASE}/")" "s-maxage=60"
contains "article sets s-maxage=3600" "$(cache_of "${BASE}/article/${SLUG}")" "s-maxage=3600"
contains "admin is no-store" "$(cache_of "${AUTH[@]}" "${BASE}/admin")" "no-store"
contains "the admin API is no-store" "$(cache_of "${AUTH[@]}" "${BASE}/api/admin/articles")" "no-store"
contains "the public API is cacheable" "$(cache_of "${BASE}/api/articles?limit=1")" "s-maxage=60"

echo
echo "Governance (SPEC §37)"
curl -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' \
  -d '{"reason":"smoke test takedown"}' "${BASE}/api/admin/articles/${ID}/takedown" > /dev/null

DOWN="$(curl -fsS "${BASE}/article/${SLUG}")"
contains "a takedown page explains itself" "$DOWN" "has been taken down"
contains "a takedown page shows the reason" "$DOWN" "smoke test takedown"
absent "a takedown page does not leak the body" "$DOWN" "article-body"
absent "a takedown page emits no JSON-LD" "$DOWN" "application/ld+json"
absent "a takedown page drops the X link" "$DOWN" "View original on X"
check "a takedown article leaves the public list" \
  "$(curl -fsS "${BASE}/api/articles?limit=100" | jqv ".articles.filter(a=>a.id==='${ID}').length")" "0"
absent "a takedown article leaves the sitemap" "$(curl -fsS "${BASE}/sitemap.xml")" "/article/${SLUG}"
absent "a takedown article leaves the feed" "$(curl -fsS "${BASE}/feed.xml")" "/article/${SLUG}"

curl -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' \
  -d '{"displayMode":"full"}' "${BASE}/api/admin/articles/${ID}/display-mode" > /dev/null
contains "restore brings the body back" "$(curl -fsS "${BASE}/article/${SLUG}")" "article-body"

check "takedown without a reason is rejected" \
  "$(status -X POST "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' -d '{}' "${BASE}/api/admin/articles/${ID}/takedown")" "400"
check "an invalid displayMode is rejected" \
  "$(status -X POST "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' -d '{"displayMode":"bogus"}' "${BASE}/api/admin/articles/${ID}/display-mode")" "400"

echo
echo "Public API shape"
API="$(curl -fsS "${BASE}/api/articles?limit=1")"
absent "the list API does not leak indexed body text" "$API" "content_text"
absent "the list API does not expose internal workflow status" "$API" '"status":"pending"'
check "an unknown API route returns JSON, not HTML" \
  "$(curl -s "${BASE}/api/nope" | jqv '.error.code')" "NOT_FOUND"
check "an unknown API route has a JSON content type" \
  "$(curl -sI "${BASE}/api/nope" | tr -d '\r' | grep -ci '^content-type: application/json')" "1"

echo
echo "▸ All public-site checks passed"
