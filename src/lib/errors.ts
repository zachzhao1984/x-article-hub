/** SPEC §25 — error codes are structured, never free text. */

export type CrawlErrorCode =
  | 'FETCH_TIMEOUT'
  | 'PAGE_BLOCKED'
  | 'EMPTY_CONTENT'
  | 'ARTICLE_NOT_FOUND'
  | 'LOGIN_REQUIRED'
  | 'PARSER_FAILED';

export type AiErrorCode = 'AI_TIMEOUT' | 'INVALID_JSON' | 'SCHEMA_MISMATCH' | 'MODEL_ERROR' | 'TOKEN_LIMIT';

export type MediaErrorCode = 'IMAGE_FETCH_FAILED' | 'INVALID_CONTENT_TYPE' | 'IMAGE_TOO_LARGE';

/** SPEC §5.2 / §22 — why a pasted URL was rejected before any row was created. */
export type ImportErrorCode =
  | 'EMPTY_INPUT'
  | 'INVALID_URL'
  | 'UNSUPPORTED_HOST'
  | 'NOT_AN_ARTICLE'
  | 'TOO_MANY_URLS';

export type AppErrorCode = ImportErrorCode | CrawlErrorCode | AiErrorCode | MediaErrorCode | 'UNAUTHORIZED' | 'NOT_FOUND' | 'BAD_REQUEST';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('BAD_REQUEST', message, 500);
}
