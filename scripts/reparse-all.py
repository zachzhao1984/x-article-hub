#!/usr/bin/env python3
"""Re-parse every article whose stored document predates the current parser version.

## Why a script and not a queue job

Re-parsing is free — it reads the raw archive in R2 and never touches X — so it can run as fast
as the endpoint answers. Pushing it through the queue would mean one message per article and a
wait on a consumer for work that has no external dependency and no rate limit.

## What it does and does not do

It calls the per-article `/parse` endpoint, which is idempotent: an article already at the
current parser version and byte-identical archive returns `unchanged` without writing anything.
So the same call covers "this one is stale, rebuild it" and "this one is current, leave it",
and the script does not need to know which is which.

It prints the outcome of each, so a run that leaves work behind says which articles those are.
"""

import argparse
import json
import os
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
    # The admin token opens the production admin API, so it is a *secret*, not a repo
    # value: read from the environment with no fallback. A default here would publish the
    # key alongside the code the moment this repository became public.
    ap.add_argument(
        "--token",
        default=os.environ.get("ADMIN_TOKEN"),
        help="admin token (defaults to $ADMIN_TOKEN)",
    )
    ap.add_argument("--delay", type=float, default=0.15)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    if not args.token:
        ap.error(
            "no admin token: pass --token or set ADMIN_TOKEN. "
            "It is the wrangler secret ADMIN_TOKEN, not a value kept in this repo."
        )

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
            # The Origin is required: Astro's CSRF guard rejects a state-changing request
            # without one before application code runs.
            headers={**headers, "Origin": base, "Content-Type": "application/json"},
        )
        return _retry(lambda: urllib.request.urlopen(req, timeout=180))

    # Only articles that have a document to rebuild. The rest have nothing stored yet.
    targets, offset, page = [], 0, 100
    while True:
        d = get(f"/api/admin/articles?limit={page}&offset={offset}")
        arts = d.get("articles") or []
        targets.extend(a for a in arts if a.get("content_r2_key"))
        if len(arts) < page:
            break
        offset += page

    if args.limit:
        targets = targets[: args.limit]

    print(f"  {len(targets)} articles with a stored document", flush=True)

    reparsed = unchanged = failed = 0
    failures = []
    for i, a in enumerate(targets, 1):
        aid = a["id"]
        label = (a.get("title") or a.get("slug") or aid)[:52]
        try:
            res = post(f"/api/admin/articles/{aid}/parse")
            if res.get("ok") is not True:
                failed += 1
                failures.append((aid, res.get("errorCode") or "failed"))
                print(f"  [{i}/{len(targets)}] x {label}  {res.get('errorCode')}", flush=True)
            elif res.get("result") == "unchanged":
                unchanged += 1
            else:
                reparsed += 1
                print(f"  [{i}/{len(targets)}] + {label}", flush=True)
        except urllib.error.HTTPError as e:
            failed += 1
            failures.append((aid, f"HTTP {e.code}"))
            print(f"  [{i}/{len(targets)}] x {label}  HTTP {e.code}", flush=True)
        except Exception as e:  # noqa: BLE001
            failed += 1
            failures.append((aid, type(e).__name__))
            print(f"  [{i}/{len(targets)}] x {label}  {type(e).__name__}", flush=True)

        if i < len(targets):
            time.sleep(args.delay)

    print(f"\n  reparsed={reparsed} unchanged={unchanged} failed={failed}", flush=True)
    for aid, why in failures:
        print(f"    x {aid}  {why}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
