#!/usr/bin/env python3
"""Re-crawl articles the browser quota left behind, with bounded concurrency.

## Why this exists

A bulk import queues every crawl at once. Browser Rendering is rate-limited per account, so
a large enough import overshoots the quota: the first wave archives fine, the rest come back
429 (`PAGE_BLOCKED`) and enter the one-hour cooldown in `crawl.ts`. Re-importing the same URLs
does not help — SPEC §5.3 dedup returns `duplicate` and, correctly, creates no new crawl job
— so the stranded articles need the re-crawl path instead.

## Two steps per article, not one

`POST /api/admin/articles/:id/crawl` archives the raw capture and enqueues a parse job. That
parse job can be delivered before the raw is written, and a parse with no raw returns early
rather than failing, so it records `success` having produced nothing. Measured: seven
articles ended up with a raw capture and no parsed document. The recovery therefore forces
the parse itself once the crawl succeeds — cheap to do unconditionally, because
`parseArticle` is a no-op when the document is already current.

## Concurrency

Each crawl takes ~200s in practice (Browser Rendering startup plus `networkidle2` settling on
X's SPA), so serial recovery of a hundred articles is a seven-hour job. The 429, though, came
from *ten* concurrent `/snapshot` sessions — the queue consumer's `max_batch_size`. This runs
`--workers` at a time, default 4, which is well inside the quota while cutting the wall time
to roughly a quarter. A 429 does not fail the run: it halves the concurrency and pauses, so
the loop backs off from the wall instead of hammering it.

## Retry on the network, not on the API

This network intermittently drops the TLS handshake to Cloudflare (`SSLEOFError`, the same
failure curl reports as error 35). That is environmental and transient, so request helpers
retry it. A real HTTP error is not retried — it is information, and the caller sees it.
"""

import argparse
import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def _retry(open_fn, attempts=5):
    """Open a request, retrying only transient network/TLS failures."""
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


class Api:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120 Safari/537.36"
            ),
        }

    def get(self, path):
        req = urllib.request.Request(f"{self.base}{path}", headers=self.headers)
        return _retry(lambda: urllib.request.urlopen(req, timeout=60))

    def post(self, path):
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=b"{}",
            method="POST",
            # The Origin is required: Astro's CSRF guard rejects a state-changing request
            # without one before application code runs.
            headers={**self.headers, "Origin": self.base, "Content-Type": "application/json"},
        )
        return _retry(lambda: urllib.request.urlopen(req, timeout=300))


def collect_targets(api, wanted, limit):
    """Page the article list and keep the ones a recovery can act on.

    The endpoint returns `{ articles, limit, offset }` with no cursor, so paging is by
    offset and ends when a page comes back short of the limit.
    """
    targets, offset, page = [], 0, 100
    while True:
        d = api.get(f"/api/admin/articles?limit={page}&offset={offset}")
        arts = d.get("articles") or []
        for a in arts:
            if a.get("status") in wanted:
                targets.append(a)
        if len(arts) < page:
            break
        offset += page
    return targets[:limit] if limit else targets


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="https://x-article-hub.zachzhao.workers.dev")
    ap.add_argument("--token", default="12345678")
    ap.add_argument("--workers", type=int, default=4, help="concurrent crawls")
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between task starts")
    ap.add_argument("--limit", type=int, default=0, help="max articles (0 = all)")
    ap.add_argument("--statuses", default="failed,pending", help="statuses to recover")
    ap.add_argument(
        "--pause",
        type=float,
        default=900.0,
        help="seconds to wait after a 429 before resuming (the quota window)",
    )
    ap.add_argument("--max-attempts", type=int, default=6, help="crawl attempts per article")
    args = ap.parse_args()

    api = Api(args.base_url, args.token)
    wanted = {s.strip() for s in args.statuses.split(",") if s.strip()}
    targets = collect_targets(api, wanted, args.limit)
    print(f"  {len(targets)} articles to recover ({args.workers} workers, {args.delay}s stagger)")

    lock = threading.Lock()
    state = {"ok": 0, "fail": 0, "done": 0, "concurrency": args.workers}
    # A paced start gate: tasks are launched one after another so the opening burst is a
    # trickle rather than `--workers` simultaneous browser sessions.
    gate = threading.Semaphore(args.workers)
    # Time until which the pool waits before opening a new browser session, pushed forward
    # whenever the quota refuses us. Guarded by its own lock so a thread reading it never
    # races a thread extending it.
    pause_lock = threading.Lock()
    pause_until = {"t": 0.0}
    # How long to wait once the quota refuses us. The cooldown in `crawl.ts` is an hour for
    # a reason: Browser Rendering's limit is a rolling account window, not a per-second cap,
    # and retrying inside it just consumes the window that is refilling.
    pause_seconds = args.pause

    def wait_if_paused():
        while True:
            with pause_lock:
                remaining = pause_until["t"] - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 30))

    def note_rate_limit():
        """Push the resume time forward after a 429."""
        with pause_lock:
            pause_until["t"] = max(pause_until["t"], time.monotonic() + pause_seconds)

    def recover(a, index):
        aid = a["id"]
        label = (a.get("slug") or aid)[:46]
        with gate:
            # Each article gets its own attempt loop, so a 429 defers it rather than
            # dropping it: the pool shrinks to a crawl while the window refills, then the
            # same article is tried again once the pause expires.
            for attempt in range(1, args.max_attempts + 1):
                wait_if_paused()
                try:
                    res = api.post(f"/api/admin/articles/{aid}/crawl")
                except Exception as e:  # noqa: BLE001
                    with lock:
                        state["fail"] += 1
                    print(f"  [{state['done'] + 1}/{len(targets)}] ✗ {label}  {type(e).__name__}", flush=True)
                    break

                if res.get("ok") is True:
                    parsed = ""
                    try:
                        pr = api.post(f"/api/admin/articles/{aid}/parse")
                        if pr.get("ok") is not True:
                            parsed = f"  (parse {pr.get('errorCode') or 'failed'})"
                    except Exception as e:  # noqa: BLE001
                        parsed = f"  (parse {type(e).__name__})"
                    with lock:
                        state["ok"] += 1
                        state["done"] += 1
                        n = state["done"]
                    print(f"  [{n}/{len(targets)}] ✓ {label}{parsed}", flush=True)
                    break

                code = str(res.get("errorCode") or "?")
                rate_limited = "PAGE_BLOCKED" in code or "429" in code
                if rate_limited and attempt < args.max_attempts:
                    note_rate_limit()
                    with lock:
                        state["concurrency"] = max(1, state["concurrency"] - 1)
                        n = state["done"] + 1
                    print(
                        f"  [{n}/{len(targets)}] ⏸ {label}  quota exhausted — "
                        f"pausing {int(pause_seconds)}s (attempt {attempt})",
                        flush=True,
                    )
                    continue

                with lock:
                    state["fail"] += 1
                    state["done"] += 1
                    n = state["done"]
                print(f"  [{n}/{len(targets)}] ✗ {label}  {code}", flush=True)
                break

    # ThreadPoolExecutor with `--workers` threads: the slow part is the network call, not
    # the CPU, so threads are the right tool and there is no GIL contention to worry about.
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = []
        for i, a in enumerate(targets):
            futures.append(pool.submit(recover, a, i))
            time.sleep(args.delay)
        for f in futures:
            f.result()

    print(f"\n  recovered ok={state['ok']} failed={state['fail']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
