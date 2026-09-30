#!/usr/bin/env bash
# Removes the R2 prefixes and D1 rows that the acceptance scripts leave behind.
#   ./scripts/cleanup-smoke.sh [base-url] [admin-token]
#
# SPEC §8 makes raw append-only, which is why deleting an article row deliberately
# leaves its captures in the bucket. That is correct for real content and wrong for
# a test fixture: running smoke.sh leaves an `articles/{id}/` prefix with nothing in
# D1 pointing at it, and those pile up invisibly. This is the counterpart — it finds
# them and tears them down.
#
# The Worker refuses to purge any prefix whose D1 row is live and is not a fixture
# (see FIXTURE_SLUG_PREFIXES in src/routes/admin-api.ts), so running this against
# production cannot touch a real article even if the id list were wrong. A prefix
# with no row at all is allowed, because nothing in the application can reach it.
#
# Safe to run at any time. It only removes prefixes that no D1 row claims.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
TOKEN="${2:-${ADMIN_TOKEN:-devtoken}}"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
ORIGIN=(-H "Origin: ${BASE}")

jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }

echo "▸ Smoke cleanup against ${BASE}"

# Fail loudly and specifically if the token is wrong. Otherwise `curl -f` aborts
# with a bare exit code and no indication that the problem is authentication.
# The pre-flight deliberately omits -f, so a 401 is not retried and the error
# message below is the only thing printed. With -f the retry policy would re-issue
# the request four times and bury the actual reason under five curl errors.
if ! curl --http1.1 -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "${BASE}/api/admin/articles?limit=1" 2>/dev/null | grep -q '^200$'; then
  echo "  cannot read the admin API with this token — pass it as the second argument" >&2
  exit 1
fi

# --http1.1 and --retry-all-errors, matching the acceptance scripts: the edge sends
# an HTTP/2 framing error or an SSL reset every so often, and without them a prefix
# silently survives a run that looked like it worked. One such failure was seen
# skipping a real prefix and reporting HTTP 000.
CURL=(curl --http1.1 --retry 4 --retry-delay 1 --retry-connrefused --retry-all-errors)

STORAGE="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/storage")"
PREFIXES="$(echo "$STORAGE" | jqv '.orphanedPrefixes.length')"
OBJECTS="$(echo "$STORAGE" | jqv '.orphanedTotal.objects')"
BYTES="$(echo "$STORAGE" | jqv '.orphanedTotal.bytes')"

if [ "$PREFIXES" = "0" ]; then
  echo "  nothing to clean — no R2 prefix lacks a D1 row"
  exit 0
fi

echo "  found ${PREFIXES} orphaned prefix(es), ${OBJECTS} object(s), ${BYTES} bytes"

# The D1 rows go first. A prefix is only orphaned *because* its row is gone, so
# purging first would race the deletion this script relies on being done.
"${CURL[@]}" -fsS -X POST "${AUTH[@]}" "${ORIGIN[@]}" "${BASE}/api/admin/demo/clear" > /dev/null 2>&1 || true

# Purge the R2 prefix. Reporting the actual status and message matters: an earlier
# version of this script collapsed every non-2xx into "not a recognised smoke
# fixture", which is a guess, and it reported a refusal that was really a
# transient. A cleanup tool that misreports why it failed is worse than one that
# stops.
purged=0
failed=0
for id in $(echo "$STORAGE" | jqv '.orphanedPrefixes.map(o=>o.articleId).join(" ")'); do
  # --http1.1 + --retry-all-errors for the same reason the acceptance scripts use
  # them: the edge sends an HTTP/2 framing error or an SSL reset every so often, and
  # without this a prefix silently survives a run that looked like it worked. One
  # such failure was seen skipping a real prefix and reporting HTTP 000.
  body_file="$(mktemp)"
  code="$(curl --http1.1 --retry 4 --retry-delay 1 --retry-connrefused --retry-all-errors \
    -s -o "$body_file" -w '%{http_code}' -X POST "${AUTH[@]}" "${ORIGIN[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"articleId\":\"${id}\",\"confirm\":\"${id}\"}" \
    "${BASE}/api/admin/maintenance/purge-prefix")" || code="000"

  if [ "$code" = "200" ]; then
    purged=$((purged + 1))
  else
    failed=$((failed + 1))
    message="$(jqv '.error.message // "no detail"' < "$body_file" 2>/dev/null || echo "no response body")"
    echo "    skipped ${id} (HTTP ${code}: ${message})"
  fi
  rm -f "$body_file"
done

echo "  purged ${purged} prefix(es)$([ "$failed" -gt 0 ] && echo ", ${failed} skipped")"

AFTER="$("${CURL[@]}" -fsS "${AUTH[@]}" "${BASE}/api/admin/storage")"
remaining="$(echo "$AFTER" | jqv '.orphanedTotal.prefixes')"
if [ "$remaining" = "0" ]; then
  echo "  ✓ bucket is clean: no orphaned prefixes remain"
else
  echo "  ✗ ${remaining} orphaned prefix(es) remain — see the reasons above"
  exit 1
fi
