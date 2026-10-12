#!/usr/bin/env python3
"""Publish every article currently in the review queue.

## Why a script rather than an endpoint

Publishing is a per-article transition in `services/publish.ts`, which validates the SPEC §6
state machine and writes a `curation_events` row for each. A "publish all" endpoint would hide
that: one request, one result, and no way to see which article failed the transition. Driving
the existing per-article endpoint keeps every publish individually attributable — the curation
log is what the archive's governance rests on, and it should not have a bulk path that writes
N events under one actor with no per-article outcome.

## What it will and will not publish

It reads the review queue and publishes each article, but it does not skip work blindly: it
prints the response for every article, counts the failures, and reports the ids it could not
publish so they can be looked at. A transition that is refused is a fact about that article's
state, not a reason to stop the run.

Idempotent: an article already published is not in the review query, so re-running after an
interruption continues rather than repeating.
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
    ap.add_argument("--delay", type=float, default=0.3, help="seconds between publishes")
    ap.add_argument("--dry-run", action="store_true")
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
            # The Origin is required: Astro's CSRF guard rejects a state-changing request
            # without one before application code runs.
            headers={**headers, "Origin": base, "Content-Type": "application/json"},
        )
        return _retry(lambda: urllib.request.urlopen(req, timeout=120))

    # Page the review queue. The list endpoint has no cursor, so it is offset-based and ends
    # when a page comes back short of the limit.
    targets, offset, page = [], 0, 100
    while True:
        d = get(f"/api/admin/articles?status=review&limit={page}&offset={offset}")
        arts = d.get("articles") or []
        targets.extend(arts)
        if len(arts) < page:
            break
        offset += page

    print(f"  {len(targets)} articles in review", flush=True)
    if args.dry_run:
        for a in targets:
            print(f"    {(a.get('title') or a.get('slug') or '')[:66]}", flush=True)
        return 0

    ok = fail = 0
    failures = []
    for i, a in enumerate(targets, 1):
        aid = a["id"]
        label = (a.get("title") or a.get("slug") or aid)[:56]
        try:
            post(f"/api/admin/articles/{aid}/publish")
            ok += 1
            print(f"  [{i}/{len(targets)}] ✓ {label}", flush=True)
        except urllib.error.HTTPError as e:
            fail += 1
            body = e.read().decode()[:100]
            failures.append((aid, f"HTTP {e.code} {body}"))
            print(f"  [{i}/{len(targets)}] ✗ {label}  HTTP {e.code} {body}", flush=True)
        except Exception as e:  # noqa: BLE001
            fail += 1
            failures.append((aid, type(e).__name__))
            print(f"  [{i}/{len(targets)}] ✗ {label}  {type(e).__name__}", flush=True)

        if i < len(targets):
            time.sleep(args.delay)

    print(f"\n  published ok={ok} failed={fail}", flush=True)
    for aid, why in failures:
        print(f"    ✗ {aid}  {why}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
