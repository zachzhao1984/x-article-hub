#!/usr/bin/env python3
"""Re-crawl articles the browser quota left behind, one at a time, with pacing.

## Why this exists

A bulk import queues every crawl at once. Browser Rendering is rate-limited per
account, so a large enough import overshoots the quota: the first wave archives
fine, the rest come back 429 (`PAGE_BLOCKED`) and enter the one-hour cooldown in
`crawl.ts`. Re-importing the same URLs does not help — SPEC §5.3 dedup returns
`duplicate` and, correctly, creates no new crawl job — so the stuck articles need
the re-crawl path instead.

`POST /api/admin/articles/:id/crawl` (SPEC §16.4) runs the crawl synchronously
and reports the real outcome, which is exactly what a paced recovery wants: one
request per article, a known result, and no queue message left behind. The loop
then just needs to be slower than the quota.

## Pacing

`--delay` is the gap between articles and is the whole point of the script: the
burst is what caused the 429, so recovery is serial by construction. Pauses grow
while failures continue, so a run that is still over quota slows down rather than
burning the remaining articles against a closed door.
"""

import argparse
import json
import time
import urllib.error
import urllib.request


def _retry(open_fn, attempts=5):
    """Open a request, retrying transient TLS/network failures.

    This network intermittently drops the TLS handshake to Cloudflare (`SSLEOFError`,
    `EOF occurred in violation of protocol`) — the same failure curl reports as error 35.
    It is environmental and transient, so a long paced run must not end because one
    handshake lost its race; a few seconds of backoff clears it.
    """
    last = None
    for i in range(attempts):
        try:
            with open_fn() as r:
                return json.loads(r.read())
        except urllib.error.HTTPError:
            raise  # a real HTTP error is informative; let the caller see it
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="https://x-article-hub.zachzhao.workers.dev")
    ap.add_argument("--token", default="12345678")
    ap.add_argument("--delay", type=float, default=12.0, help="seconds between crawls")
    ap.add_argument("--limit", type=int, default=0, help="max articles to attempt (0 = all)")
    ap.add_argument("--statuses", default="retrying,failed", help="which article statuses to recover")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")
    ua = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120 Safari/537.36"
    )
    headers = {"Authorization": f"Bearer {args.token}", "User-Agent": ua}

    def get(path):
        req = urllib.request.Request(f"{base}{path}", headers=headers)
        return _retry(lambda: urllib.request.urlopen(req, timeout=60))

    def post(path):
        req = urllib.request.Request(
            f"{base}{path}",
            data=b"{}",
            method="POST",
            # The Origin is required: Astro's CSRF guard rejects a state-changing
            # request without one before application code runs.
            headers={**headers, "Origin": base, "Content-Type": "application/json"},
        )
        return _retry(lambda: urllib.request.urlopen(req, timeout=180))

    # The list endpoint returns `{ articles, limit, offset }` with no cursor, so paging is
    # by offset and ends when a page comes back short of the limit.
    wanted = {s.strip() for s in args.statuses.split(",") if s.strip()}
    targets = []
    limit = 100
    offset = 0
    while True:
        page = get(f"/api/admin/articles?limit={limit}&offset={offset}")
        arts = page.get("articles") or []
        for a in arts:
            # The workflow status that means "the crawl did not finish" is `failed` (the
            # crawl writes its failure to the article) with `pending` covering one that is
            # still queued or mid-retry.
            if a.get("status") in wanted:
                targets.append(a)
        if len(arts) < limit:
            break
        offset += limit

    if args.limit:
        targets = targets[: args.limit]

    print(f"  {len(targets)} articles to re-crawl (delay {args.delay}s)")

    ok = fail = 0
    backoff = args.delay
    for i, a in enumerate(targets, 1):
        aid = a["id"]
        label = (a.get("slug") or aid)[:48]
        try:
            res = post(f"/api/admin/articles/{aid}/crawl")
            # The endpoint returns the outcome fields at the top level ({ ok, result,
            # errorCode, ... }), not nested.
            succeeded = res.get("ok") is True
            if succeeded:
                ok += 1
                # A success means the quota has room again; return to the base pace.
                backoff = args.delay
                print(f"  [{i}/{len(targets)}] ✓ {label}")
            else:
                fail += 1
                code = res.get("errorCode") or "?"
                print(f"  [{i}/{len(targets)}] ✗ {label}  {code}")
                # Still rate-limited: slow down instead of hammering the same wall.
                if "PAGE_BLOCKED" in str(code) or "429" in str(code):
                    backoff = min(backoff * 1.5, 90)
        except urllib.error.HTTPError as e:
            fail += 1
            body = e.read().decode()[:120]
            print(f"  [{i}/{len(targets)}] ✗ {label}  HTTP {e.code} {body}")
            backoff = min(backoff * 1.5, 90)
        except Exception as e:  # noqa: BLE001 — a network blip must not end the run
            fail += 1
            print(f"  [{i}/{len(targets)}] ✗ {label}  {type(e).__name__}: {e}")
            backoff = min(backoff * 1.5, 90)

        if i < len(targets):
            time.sleep(backoff)

    print(f"\n  re-crawled ok={ok} failed={fail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
