#!/usr/bin/env bash
# SPEC §38 Phase 1 acceptance check against a running Worker (local dev or deployed).
#   ./scripts/smoke.sh [base-url] [admin-token]
#
# The token can also come from the ADMIN_TOKEN environment variable.
#
# Uses fresh article ids per run so it can be executed repeatedly against the same
# database without the dedup assertions passing vacuously.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
TOKEN="${2:-${ADMIN_TOKEN:-devtoken}}"

# Cloudflare applies CSRF protection to Workers: a POST without a same-origin
# `Origin` header is rejected with 403 "Cross-site POST form submissions are
# forbidden" before the Worker ever runs. Browsers always send Origin on a
# same-origin form POST, so this only affects scripted clients like this one.
ORIGIN=(-H "Origin: ${BASE}")
AUTH=(-H "Authorization: Bearer ${TOKEN}")

# No --retry-all-errors: that retries on 4xx too, so every negative check below
# (401, 403, 404) would be re-issued four times. The default retry set — 5xx,
# timeouts, connection refused — is exactly the transient network noise that
# was failing checks unrelated to what they test.
# --http1.1 is load-bearing. Every transient failure seen here was an HTTP/2
# framing-layer error or an SSL_connect reset from the edge, and plain --retry
# covers neither; over HTTP/1.1 the same 60-request burst produced zero failures.
#
# --retry-all-errors is what makes an SSL reset actually re-issue. It only widens
# the retry set for requests that use -f, and every check here that asserts a
# rejection deliberately omits -f so it can read the status code — so the negative
# checks are still issued exactly once. Verified against a local server returning
# 401: with -f the request lands 5 times, without -f exactly once.
CURL=(curl --http1.1 --retry 4 --retry-delay 1 --retry-connrefused --retry-all-errors)

RUN_ID="$(node -e 'process.stdout.write(String(Date.now()))')"
A1="${RUN_ID}1"
A2="${RUN_ID}2"
A3="${RUN_ID}3"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

# Occurrences rather than lines. The admin pages are emitted as one long line, so
# `grep -c` answers "is this present" and not "how many of these are there" — which is
# how a five-option assertion silently becomes a one. `|| true` because grep exits 1 on
# no match, and `pipefail` would turn that into a failed substitution.
count() { printf '%s' "$1" | grep -oE "$2" | wc -l | tr -d ' ' || true; }

jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }

echo "▸ SPEC §38 Phase 1 acceptance against ${BASE}  (run id ${RUN_ID})"

echo
echo "Public API"
check "GET /api/health returns ok" "$("${CURL[@]}" -fsS "${BASE}/api/health" | jqv '.ok')" "true"
check "GET /api/categories returns the 5 seeded categories" "$("${CURL[@]}" -fsS "${BASE}/api/categories" | jqv '.categories.length')" "5"

echo
echo "Admin auth (SPEC §24)"
check "admin API rejects a request without credentials" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/articles")" "401"
check "admin API accepts the shared token" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/api/admin/articles")" "200"
check "a bogus bearer token is rejected" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "${BASE}/api/admin/articles")" "401"

echo
echo "Import (SPEC §5 / §22)"
FIRST="$("${CURL[@]}" -fsS "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' \
  -d "{\"urls\":[\"https://x.com/karpathy/article/${A1}\",\"https://x.com/someone/article/${A2}\"]}" \
  "${BASE}/api/admin/articles/import")"

check "batch import creates 2 articles" "$(echo "$FIRST" | jqv '.created')" "2"
check "response reports 0 duplicates on a fresh import" "$(echo "$FIRST" | jqv '.duplicates')" "0"
check "created articles are queued, not crawled" "$(echo "$FIRST" | jqv '.articles[0].status')" "queued"
check "canonical URL is normalized" "$(echo "$FIRST" | jqv '.articles[0].canonicalUrl')" "https://x.com/karpathy/article/${A1}"

BATCH="https://x.com/karpathy/article/${A1}
twitter.com/karpathy/article/${A1}?s=20&t=xyz
https://x.com/someone/article/${A2}
https://x.com/karpathy/article/${A1}
https://example.com/not-x/article/${A3}
https://x.com/karpathy/status/${A1}
https://x.com/karpathy/photo/${A3}"

MIXED="$("${CURL[@]}" -fsS "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: text/plain' --data-binary "$BATCH" "${BASE}/api/admin/articles/import")"
check "5 already-known URLs collapse to duplicates, incl. an in-batch repeat" "$(echo "$MIXED" | jqv '.duplicates')" "5"
check "duplicate input reports the existing article id" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.status==="duplicate").every(o=>typeof o.articleId==="string")')" "true"
check "the foreign host reports UNSUPPORTED_HOST" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.code==="UNSUPPORTED_HOST").length')" "1"
check "a non-article path segment reports NOT_AN_ARTICLE" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.code==="NOT_AN_ARTICLE").length')" "1"
check "2 invalid URLs are rejected" "$(echo "$MIXED" | jqv '.failed')" "2"
check "the mixed batch created no new article" "$(echo "$MIXED" | jqv '.created')" "0"
# The /status/ permalink of an Article is the URL people actually copy. It must
# resolve to the same row as the /article/ form and normalize to the /article/ URL,
# which is the page that holds the content. Before normalization this was rejected
# outright, and a naive relaxation would have created a second article — the exact
# failure SPEC §5.3's dedup exists to prevent.
check "an Article's /status/ permalink normalizes to the /article/ URL" \
  "$(echo "$MIXED" | jqv ".outcomes.filter(o=>o.input==='https://x.com/karpathy/status/${A1}').every(o=>o.canonicalUrl==='https://x.com/karpathy/article/${A1}')")" "true"
check "that permalink is reported as a duplicate, not a new article" \
  "$(echo "$MIXED" | jqv ".outcomes.filter(o=>o.input==='https://x.com/karpathy/status/${A1}').every(o=>o.status==='duplicate')")" "true"

# SPEC §6 — only `published` rows are public. The rows created above are all
# `pending`, so none of them may appear in the public list. Asserting on the ids
# rather than on a count keeps this true even when published content exists.
PUBLIC_IDS="$("${CURL[@]}" -fsS "${BASE}/api/articles?limit=100" | jqv '.articles.map(a=>a.id).join(",")')"
check "imported but unpublished articles are not exposed publicly" \
  "$(echo "$FIRST" | jqv ".articles.filter(a=>\"${PUBLIC_IDS}\".split(\",\").includes(a.id)).length")" "0"

echo
echo "Queue + job state (SPEC §19)"
ARTICLE_ID="$(echo "$FIRST" | jqv '.articles[0].id')"
DETAIL="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}")"
check "the crawl job exists" "$(echo "$DETAIL" | jqv '.jobs.length')" "1"
check "the crawl job type is crawl" "$(echo "$DETAIL" | jqv '.jobs[0].job_type')" "crawl"
check "an import curation event was recorded" "$(echo "$DETAIL" | jqv '.events[0].action')" "import"
check "the article starts in the pending state (SPEC §6)" "$(echo "$DETAIL" | jqv '.article.status')" "pending"
check "the site slug is derived from the username and article id" \
  "$(echo "$DETAIL" | jqv '.article.slug')" "karpathy-${A1}"

RETRY1="$("${CURL[@]}" -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}/retry")"
RETRY2="$("${CURL[@]}" -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}/retry")"
ATTEMPT1="$(echo "$RETRY1" | jqv '.attempt')"
ATTEMPT2="$(echo "$RETRY2" | jqv '.attempt')"
# Delivery to the consumer is asynchronous, so the stored attempt count can differ
# by one between calls; what must hold is that each retry strictly advances it.
check "each retry advances the attempt counter" "$([ "$ATTEMPT2" -gt "$ATTEMPT1" ] && echo yes)" "yes"
check "retry re-queues the same crawl job" \
  "$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}" | jqv '.jobs.length')" "1"
check "retry is audited" \
  "$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}" | jqv '.events.filter(e=>e.action==="retry").length')" "2"

echo
echo "Admin UI (SPEC §16)"
check "the dashboard renders" \
  "$("${CURL[@]}" -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin")" "200"
check "the import page renders" \
  "$("${CURL[@]}" -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/import")" "200"
check "the article detail page renders" \
  "$("${CURL[@]}" -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")" "200"
check "the jobs page renders" \
  "$("${CURL[@]}" -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/jobs")" "200"
check "admin responses are not cached (SPEC §23)" \
  "$("${CURL[@]}" -sI "${AUTH[@]}" "${BASE}/admin" | tr -d '\r' | grep -ci '^cache-control: no-store')" "1"

echo
echo "Curation: category (SPEC §16.3)"
# This control was missing for the length of a phase while the service function and the
# API endpoint for it both existed, so every article sat in no category and every chip
# read zero. A check that only "the pages render" would have kept passing; what failed
# was the control being absent, so that is what is asserted.
DETAIL_HTML="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")"
check "the article page offers a category control" \
  "$(count "$DETAIL_HTML" 'name="categoryId"')" "1"
check "all five seeded categories are offered" \
  "$(count "$DETAIL_HTML" '<option value="cat_(ai|technology|business|science|ideas)"')" "5"
check "there is a way to clear the category" \
  "$(count "$DETAIL_HTML" '<option value=""[^>]*>[^<]*none')" "1"
check "an uncategorised article starts on none" \
  "$(count "$DETAIL_HTML" '<option value="" selected>')" "1"

# Sent the way a browser sends it: form encoding, plus the same-origin Origin that
# Cloudflare's CSRF check demands before the Worker runs at all.
"${CURL[@]}" -fsS -o /dev/null -X POST "${AUTH[@]}" "${ORIGIN[@]}" \
  --data-urlencode 'categoryId=cat_ai' "${BASE}/admin/articles/${ARTICLE_ID}/category"
check "saving a category preselects it on reload" \
  "$(count "$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")" '<option value="cat_ai" selected>')" "1"

# The soft-reference guard. `editor_category_id` has no foreign key and every read joins
# through it, so an unvalidated value is stored silently and the article simply
# reappears as uncategorised — which nothing on the page reports.
"${CURL[@]}" -fsS -o /dev/null -X POST "${AUTH[@]}" "${ORIGIN[@]}" \
  --data-urlencode 'categoryId=cat_nope' "${BASE}/admin/articles/${ARTICLE_ID}/category"
check "an unknown category is refused and the stored value survives" \
  "$(count "$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")" '<option value="cat_ai" selected>')" "1"

"${CURL[@]}" -fsS -o /dev/null -X POST "${AUTH[@]}" "${ORIGIN[@]}" \
  --data-urlencode 'categoryId=' "${BASE}/admin/articles/${ARTICLE_ID}/category"
check "clearing the category returns the article to none" \
  "$(count "$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")" '<option value="" selected>')" "1"

echo
echo "Browser login flow (SPEC §24)"
check "the login form is served" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' "${BASE}/admin/login")" "200"
check "an unauthenticated admin page redirects to the login form" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' "${BASE}/admin")" "303"
check "a POST without a same-origin Origin is blocked by Cloudflare CSRF protection" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -X POST -d "token=${TOKEN}" "${BASE}/admin/login")" "403"
check "a wrong token is rejected" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -X POST "${ORIGIN[@]}" -d 'token=definitely-wrong' "${BASE}/admin/login")" "401"

COOKIE="$("${CURL[@]}" -s -D - -o /dev/null -X POST "${ORIGIN[@]}" -d "token=${TOKEN}" "${BASE}/admin/login" \
  | tr -d '\r' | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: *//; s/;.*$//')"

check "a correct token sets a session cookie" "$([ -n "$COOKIE" ] && echo yes)" "yes"
check "the cookie authenticates the dashboard" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/admin")" "200"
check "the cookie authenticates the admin API" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/api/admin/articles")" "200"
check "a forged cookie is rejected" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -H "Cookie: xah_admin=1" "${BASE}/admin")" "303"
check "an empty cookie is rejected" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -H "Cookie: xah_admin=" "${BASE}/admin")" "303"
check "the cookie is not the token in the clear" \
  "$(echo "$COOKIE" | grep -cF "$TOKEN")" "0"

echo
echo "Storage report (SPEC §8 / §10)"
STORAGE="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/storage")"
# jqv prepends `j` to the expression, so an assertion has to be a single member
# chain off that root — a second bare `.foo` would be a syntax error, and a
# parenthesised path would be read as a call.
check "the storage report counts objects" \
  "$(echo "$STORAGE" | jqv '.total.objects >= 0')" "true"
check "the storage report totals bytes" \
  "$(echo "$STORAGE" | jqv '.total.bytes >= 0')" "true"
check "the storage report breaks media down by status" \
  "$(echo "$STORAGE" | jqv '.media.length >= 0')" "true"
# This run created two articles and nothing else should be unaccounted for. An
# orphan whose id is not fixture-shaped means something real is not being tracked.
check "every orphan is a fixture-shaped article id" \
  "$(echo "$STORAGE" | jqv '.orphanedPrefixes.every(o => /^art_[a-z0-9]{16,32}$/.test(o.articleId))')" "true"

echo
echo "Purge guard (SPEC §8 — append-only means a teardown must be deliberate)"
purge() {
  "${CURL[@]}" -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" "${ORIGIN[@]}" \
    -H 'Content-Type: application/json' -d "$1" "${BASE}/api/admin/maintenance/purge-prefix"
}

check "purging without a confirm is refused" \
  "$(purge "{\"articleId\":\"${ARTICLE_ID}\"}")" "400"
check "purging a malformed id is refused before it becomes a wide prefix" \
  "$(purge '{"articleId":"../..","confirm":"../.."}')" "400"
check "a confirm that does not repeat the id is refused" \
  "$(purge "{\"articleId\":\"${ARTICLE_ID}\",\"confirm\":\"something-else\"}")" "400"
check "purging an id with nothing stored reports 404 rather than succeeding quietly" \
  "$(purge '{"articleId":"art_zzzzzzzzzzzzzzzz","confirm":"art_zzzzzzzzzzzzzzzz"}')" "404"
# The check that matters: a published article is real content, so the endpoint must
# refuse it even with a valid id and a matching confirm. Without this a typo in a
# cleanup script could delete a real capture, and SPEC §8's append-only guarantee
# would be a lie.
REAL_ID="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/articles?limit=100" \
  | jqv '.articles.filter(a=>a.status==="published").map(a=>a.id)[0] || ""')"
if [ -n "$REAL_ID" ] && [ "$REAL_ID" != "undefined" ]; then
  check "purging a published article is refused" \
    "$(purge "{\"articleId\":\"${REAL_ID}\",\"confirm\":\"${REAL_ID}\"}")" "403"
else
  pass "purging a published article is refused (no published article to test against)"
fi
check "an unauthenticated purge is rejected" \
  "$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -X POST "${ORIGIN[@]}" -H 'Content-Type: application/json' \
     -d "{\"articleId\":\"${ARTICLE_ID}\",\"confirm\":\"${ARTICLE_ID}\"}" \
     "${BASE}/api/admin/maintenance/purge-prefix")" "401"

echo
echo "▸ All Phase 1 checks passed"
