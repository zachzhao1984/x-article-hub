/**
 * SPEC §19 — one message shape for every queue in the system.
 *
 * Consumers must be idempotent (SPEC §19): every field here is enough to look up
 * the row in `crawl_jobs` and decide whether the work still needs doing.
 */
export type JobType = 'crawl' | 'parse' | 'media' | 'ai' | 'metrics' | 'reindex';

export interface JobMessage {
  jobId: string;
  articleId: string;
  type: JobType;
  attempt: number;
  createdAt: number;
}

/** SPEC §11.8 / §6 — lifecycle of a single unit of work. */
export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'retrying'
  | 'failed'
  | 'skipped';

/** SPEC §6 — lifecycle of an article. */
export type ArticleStatus =
  | 'pending'
  | 'fetching'
  | 'fetched'
  | 'parsing'
  | 'review'
  | 'published'
  | 'rejected'
  | 'archived'
  | 'takedown'
  | 'failed';

/** SPEC §37 — how much of the archived body may be shown publicly. */
export type DisplayMode = 'full' | 'excerpt' | 'link_only' | 'takedown';

export function isJobMessage(value: unknown): value is JobMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobId === 'string' &&
    typeof v.articleId === 'string' &&
    typeof v.type === 'string' &&
    ['crawl', 'parse', 'media', 'ai', 'metrics', 'reindex'].includes(v.type) &&
    typeof v.attempt === 'number' &&
    typeof v.createdAt === 'number'
  );
}
