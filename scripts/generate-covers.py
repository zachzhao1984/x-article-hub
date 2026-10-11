#!/usr/bin/env python3
"""Generate covers for articles that have none, one at a time, with pacing.

## Why one at a time

A cover takes roughly forty seconds of Workers AI time. A batch endpoint that awaits several
of them exceeds the point at which the edge gives up on the response — measured: `HTTP 000`
after 61 seconds, with the covers generating anyway, so the work was done and only the reply
was lost. Running the generation in the background after responding does not fix it either:
the Worker's post-response isolation lives long enough for about one cover.

So this drives the per-article endpoint, which is synchronous and returns a real outcome in
one request. The loop is the batch, and each iteration is small enough to complete.

## Why it is sequential

Workers AI is the constraint, not the Worker. Firing the requests in parallel makes each one
slower rather than making the set finish sooner, which is what turned a 15-second call into a
40-second one during the investigation. Serial keeps each call at its own pace.

Resumable by construction: the endpoint's own idempotency check skips articles that already
have a cover, so re-running after an interruption continues rather than repeating.
"""

import argparse
import json
import time
import urllib.error
import urllib.request


def _retry(open_fn, attempts=4):
    """Open a request, retrying transient network/TLS failures only."""
    last = None
    for i in range(attempts):
        try:
            with open_fn() as r:
                return json.loads(r.read())
        except urllib.error.HTTPError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="https://x-article-hub.zachzhao.workers.dev")
    ap.add_argument("--token", default="12345678")
    ap.add_argument("--limit", type=int, default=0, help="max covers to generate (0 = all missing)")
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between covers")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")
    headers = {
        "Authorization": f"Bearer {args.token}",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120 Safari/537.36"
        ),
    }

    def get(path):
        return _retry(lambda: urllib.request.urlopen(urllib.request.Request(f"{base}{path}", headers=headers), timeout=60))

    def post(path):
        req = urllib.request.Request(
            f"{base}{path}",
            data=b"{}",
            method="POST",
            headers={**headers, "Origin": base, "Content-Type": "application/json"},
        )
        return _retry(lambda: urllib.request.urlopen(req, timeout=180))

    # Find the articles that need one. The admin list reports `cover_image_id` already
    # resolved against body-then-cover, so a null there is exactly the set to work on.
    targets, offset, page = [], 0, 100
    while True:
        d = get(f"/api/admin/articles?limit={page}&offset={offset}")
        arts = d.get("articles") or []
        for a in arts:
            if not a.get("cover_image_id") and a.get("status") in ("review", "published", "archived"):
                targets.append(a)
        if len(arts) < page:
            break
        offset += page

    if args.limit:
        targets = targets[: args.limit]

    print(f"  {len(targets)} articles need a cover (delay {args.delay}s)", flush=True)

    ok = fail = 0
    for i, a in enumerate(targets, 1):
        aid = a["id"]
        label = (a.get("title") or a.get("slug") or aid)[:52]
        try:
            res = post(f"/api/admin/articles/{aid}/cover")
            if res.get("ok") is True:
                ok += 1
                # `exists` means a cover was already there — counted as fine, not as work.
                mark = "✓" if res.get("result") == "generated" else "="
                print(f"  [{i}/{len(targets)}] {mark} {label}", flush=True)
            else:
                fail += 1
                print(f"  [{i}/{len(targets)}] ✗ {label}  {res.get('errorCode')}", flush=True)
        except urllib.error.HTTPError as e:
            fail += 1
            print(f"  [{i}/{len(targets)}] ✗ {label}  HTTP {e.code}", flush=True)
        except Exception as e:  # noqa: BLE001
            fail += 1
            print(f"  [{i}/{len(targets)}] ✗ {label}  {type(e).__name__}", flush=True)

        if i < len(targets):
            time.sleep(args.delay)

    print(f"\n  covers ok={ok} failed={fail}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
