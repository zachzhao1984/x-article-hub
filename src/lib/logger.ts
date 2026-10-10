/**
 * SPEC §35 — observability.
 *
 * Every line is a single JSON object so Workers Logs can be filtered by event
 * name and correlated by `job_id` / `article_id`.
 */

export type LogEvent =
  // import (SPEC §16.2, §22)
  | 'import_received'
  | 'import_created'
  | 'import_duplicate'
  | 'import_rejected'
  | 'queue_published'
  // queue ingest (Phase 1)
  | 'ingest_received'
  | 'ingest_deferred'
  | 'ingest_invalid'
  // reserved for later phases (SPEC §35)
  | 'crawl_success'
  | 'crawl_failed'
  | 'parse_success'
  | 'parse_failed'
  | 'ai_success'
  | 'ai_failed'
  | 'media_success'
  | 'media_failed'
  | 'publish'
  // platform
  | 'admin_unauthorized'
  | 'admin_login'
  | 'http_error'
  // SPEC §43 — reader accounts
  | 'oauth_start'
  | 'oauth_declined'
  | 'oauth_callback_incomplete'
  | 'oauth_state_rejected'
  | 'oauth_callback_failed'
  | 'oauth_login'
  | 'login_created'
  | 'login_identity_linked'
  | 'login_identity_owned_by_other'
  | 'login_link_target_gone'
  | 'admin_denied_role'
  // SPEC §21 — scheduling
  | 'ranking_refresh'
  | 'ranking_refresh_start'
  | 'ranking_refresh_failed'
  // SPEC §16 — destructive
  | 'article_deleted'
  | 'article_delete_refused';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  job_id?: string;
  article_id?: string;
  job_type?: string;
  attempt?: number;
  started_at?: number;
  completed_at?: number;
  duration_ms?: number;
  status?: string;
  error_code?: string;
  error_message?: string;
  // SPEC §43 — accounts. `provider` and `role` are free strings rather than a union
  // because a log line is the one place where recording what an attacker or a
  // half-finished setup actually sent is worth more than the type being narrow.
  user_id?: string;
  provider?: string;
  role?: string;
  outcome?: string;
  actor?: string;
  linking?: boolean;
  reason?: string;
  has_state?: boolean;
  has_code?: boolean;
  found?: boolean;
  state_provider?: string | null;
  has_email?: boolean;
  metrics_fields?: number;
  // SPEC §16 — hard delete. Counted before the cascade, so they describe what was removed.
  had_row?: boolean;
  r2_objects?: number;
  r2_bytes?: number;
  slug?: string | null;
  versions?: number;
  media?: number;
  jobs?: number;
  events?: number;
  tags?: number;
  metrics?: number;
  // SPEC §14.4 / §21 — the ranking refresh.
  scored?: number;
  with_metrics?: number;
  without_metrics?: number;
  weights?: { popularity: number; quality: number; editor: number };
  note?: string;
  via?: string;
  link_to_user_id?: string;
  browser_ms_used?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
  const payload = JSON.stringify({ event, level, ...fields });
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

export const log = {
  debug: (event: LogEvent, fields?: LogFields) => emit('debug', event, fields),
  info: (event: LogEvent, fields?: LogFields) => emit('info', event, fields),
  warn: (event: LogEvent, fields?: LogFields) => emit('warn', event, fields),
  error: (event: LogEvent, fields?: LogFields) => emit('error', event, fields),
};
