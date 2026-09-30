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

RUN_ID="$(node -e 'process.stdout.write(String(Date.now()))')"
A1="${RUN_ID}1"
A2="${RUN_ID}2"
A3="${RUN_ID}3"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }

echo "▸ SPEC §38 Phase 1 acceptance against ${BASE}  (run id ${RUN_ID})"

echo
echo "Public API"
check "GET /api/health returns ok" "$(curl -fsS "${BASE}/api/health" | jqv '.ok')" "true"
check "GET /api/categories returns the 5 seeded categories" "$(curl -fsS "${BASE}/api/categories" | jqv '.categories.length')" "5"

echo
echo "Admin auth (SPEC §24)"
check "admin API rejects a request without credentials" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/articles")" "401"
check "admin API accepts the shared token" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/api/admin/articles")" "200"
check "a bogus bearer token is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "${BASE}/api/admin/articles")" "401"

echo
echo "Import (SPEC §5 / §22)"
FIRST="$(curl -fsS "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: application/json' \
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
https://x.com/karpathy/status/${A3}"

MIXED="$(curl -fsS "${AUTH[@]}" "${ORIGIN[@]}" -H 'Content-Type: text/plain' --data-binary "$BATCH" "${BASE}/api/admin/articles/import")"
check "4 already-known URLs collapse to duplicates, incl. an in-batch repeat" "$(echo "$MIXED" | jqv '.duplicates')" "4"
check "duplicate input reports the existing article id" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.status==="duplicate").every(o=>typeof o.articleId==="string")')" "true"
check "the foreign host reports UNSUPPORTED_HOST" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.code==="UNSUPPORTED_HOST").length')" "1"
check "the status permalink reports NOT_AN_ARTICLE" \
  "$(echo "$MIXED" | jqv '.outcomes.filter(o=>o.code==="NOT_AN_ARTICLE").length')" "1"
check "2 invalid URLs are rejected" "$(echo "$MIXED" | jqv '.failed')" "2"
check "the mixed batch created no new article" "$(echo "$MIXED" | jqv '.created')" "0"

# SPEC §6 — only `published` rows are public. The rows created above are all
# `pending`, so none of them may appear in the public list. Asserting on the ids
# rather than on a count keeps this true even when published content exists.
PUBLIC_IDS="$(curl -fsS "${BASE}/api/articles?limit=100" | jqv '.articles.map(a=>a.id).join(",")')"
check "imported but unpublished articles are not exposed publicly" \
  "$(echo "$FIRST" | jqv ".articles.filter(a=>\"${PUBLIC_IDS}\".split(\",\").includes(a.id)).length")" "0"

echo
echo "Queue + job state (SPEC §19)"
ARTICLE_ID="$(echo "$FIRST" | jqv '.articles[0].id')"
DETAIL="$(curl -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}")"
check "the crawl job exists" "$(echo "$DETAIL" | jqv '.jobs.length')" "1"
check "the crawl job type is crawl" "$(echo "$DETAIL" | jqv '.jobs[0].job_type')" "crawl"
check "an import curation event was recorded" "$(echo "$DETAIL" | jqv '.events[0].action')" "import"
check "the article starts in the pending state (SPEC §6)" "$(echo "$DETAIL" | jqv '.article.status')" "pending"
check "the site slug is derived from the username and article id" \
  "$(echo "$DETAIL" | jqv '.article.slug')" "karpathy-${A1}"

RETRY1="$(curl -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}/retry")"
RETRY2="$(curl -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}/retry")"
ATTEMPT1="$(echo "$RETRY1" | jqv '.attempt')"
ATTEMPT2="$(echo "$RETRY2" | jqv '.attempt')"
# Delivery to the consumer is asynchronous, so the stored attempt count can differ
# by one between calls; what must hold is that each retry strictly advances it.
check "each retry advances the attempt counter" "$([ "$ATTEMPT2" -gt "$ATTEMPT1" ] && echo yes)" "yes"
check "retry re-queues the same crawl job" \
  "$(curl -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}" | jqv '.jobs.length')" "1"
check "retry is audited" \
  "$(curl -fsS "${AUTH[@]}" "${BASE}/api/admin/articles/${ARTICLE_ID}" | jqv '.events.filter(e=>e.action==="retry").length')" "2"

echo
echo "Admin UI (SPEC §16)"
check "the dashboard renders" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin")" "200"
check "the import page renders" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/import")" "200"
check "the article detail page renders" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/articles/${ARTICLE_ID}")" "200"
check "the jobs page renders" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/admin/jobs")" "200"
check "admin responses are not cached (SPEC §23)" \
  "$(curl -sI "${AUTH[@]}" "${BASE}/admin" | tr -d '\r' | grep -ci '^cache-control: no-store')" "1"

echo
echo "Browser login flow (SPEC §24)"
check "the login form is served" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/admin/login")" "200"
check "an unauthenticated admin page redirects to the login form" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/admin")" "303"
check "a POST without a same-origin Origin is blocked by Cloudflare CSRF protection" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "token=${TOKEN}" "${BASE}/admin/login")" "403"
check "a wrong token is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${ORIGIN[@]}" -d 'token=definitely-wrong' "${BASE}/admin/login")" "401"

COOKIE="$(curl -s -D - -o /dev/null -X POST "${ORIGIN[@]}" -d "token=${TOKEN}" "${BASE}/admin/login" \
  | tr -d '\r' | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: *//; s/;.*$//')"

check "a correct token sets a session cookie" "$([ -n "$COOKIE" ] && echo yes)" "yes"
check "the cookie authenticates the dashboard" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/admin")" "200"
check "the cookie authenticates the admin API" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${COOKIE}" "${BASE}/api/admin/articles")" "200"
check "a forged cookie is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: xah_admin=1" "${BASE}/admin")" "303"
check "an empty cookie is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: xah_admin=" "${BASE}/admin")" "303"
check "the cookie is not the token in the clear" \
  "$(echo "$COOKIE" | grep -cF "$TOKEN")" "0"

echo
echo "▸ All Phase 1 checks passed"
