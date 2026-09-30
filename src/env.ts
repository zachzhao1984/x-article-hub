/**
 * Runtime bindings.
 *
 * The runtime types (`D1Database`, `R2Bucket`, `BrowserRun`, `Ai`, `Fetcher`,
 * `Queue`) are ambient globals emitted by `npm run cf-typegen`
 * (`worker-configuration.d.ts`). This interface re-declares them so the app has
 * a single named `Env` to import, and so secret bindings that intentionally do
 * not appear in `wrangler.jsonc` still get type-checked.
 */

import type { JobMessage } from './jobs/types';

export interface Env {
  /** SPEC §11 — relational metadata, state, indexes. */
  DB: D1Database;
  /** SPEC §8 — raw archive, normalized versions, media. */
  ARCHIVE: R2Bucket;
  /** SPEC §3 — static assets (admin css, placeholder public landing). */
  ASSETS: Fetcher;
  /** SPEC §7 — Browser Run Quick Actions. Wired in Phase 0, consumed in Phase 2. */
  BROWSER: BrowserRun;
  /** SPEC §13 — Workers AI. Wired in Phase 0, consumed in Phase 4. */
  AI: Ai;

  /** SPEC §19 — crawl jobs. */
  ARTICLE_INGEST_QUEUE: Queue<JobMessage>;
  /** SPEC §19 — parse / AI jobs. */
  ARTICLE_PROCESS_QUEUE: Queue<JobMessage>;
  /** SPEC §19 — metrics jobs. */
  ARTICLE_METRICS_QUEUE: Queue<JobMessage>;

  SITE_NAME: string;
  SITE_ORIGIN: string;
  /** SPEC §14.4 — ranking weights must be configurable, never hard-coded. */
  RANKING_WEIGHTS_JSON: string;
  /** SPEC §16.2 — guard against pasting a whole file by accident. */
  MAX_IMPORT_URLS: string;

  /** SPEC §24 — local-dev shim only. Production gates admin with Cloudflare Access. */
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
}
