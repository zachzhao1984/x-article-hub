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
  | 'cron_noop';

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
