/**
 * SPEC §7 — Browser Run access.
 *
 * SPEC §25 is specific about one thing here: "抓取 Worker 必须记录 timeout 类型，
 * 不要简单统一成'抓取失败'" (record the timeout type, do not collapse it into
 * "fetch failed"). Browser Run has three independent clocks — page load
 * (`gotoOptions.timeout`), the action itself (`actionTimeout`), and selector
 * waiting (`waitForSelector.timeout`) — plus distinct HTTP statuses. Each maps to
 * its own SPEC §25 code so an operator can tell "X was slow" from "X blocked us".
 *
 * SPEC §36 cost note: the primary action is `/snapshot`, not `/markdown`. A
 * snapshot returns Markdown *and* rendered HTML in a single browser session, which
 * is half the spend of two separate calls — and this account hits Browser Run's
 * rate limit quickly enough that the difference is the difference between
 * archiving the HTML and silently not.
 */

import type { CrawlErrorCode } from '../lib/errors';
import { log } from '../lib/logger';

/** §7.3 — X is a React SPA; the default load event returns before content renders. */
export const X_GOTO_OPTIONS = {
  waitUntil: 'networkidle2',
  timeout: 45_000,
} as const;

/** §36 — blocking asset subresources cuts Browser Run time, which is billed. */
export const REJECT_REQUEST_PATTERNS = [
  '/\\.(css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot)$/i',
  '/\\.(mp4|webm|mov|m3u8)$/i',
  '/(analytics|telemetry|ads|doubleclick|googlesyndication)\\./i',
] as const;

/** Browser Run defaults to a desktop Chrome UA; X serves the same shell either way. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** SPEC §39 lists a screenshot as optional; it is opt-in because it is the priciest format. */
export const SCREENSHOT_FORMAT = 'screenshot';

export type QuickAction = 'markdown' | 'content' | 'snapshot';

export interface QuickActionResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** SPEC §35 — cost monitoring. */
  browserMsUsed: number | null;
  errorCode: CrawlErrorCode | null;
  errorMessage: string | null;
  /** SPEC §36 — true when our own quota, not the target, stopped the crawl. */
  rateLimited: boolean;
}

export interface QuickActionOptions {
  url: string;
  /** SPEC §26 item 2 — Puppeteer setCookie() objects, from the X_COOKIES_JSON secret. */
  cookies?: unknown[];
  /** `/snapshot` only. */
  formats?: string[];
}

function buildOptions(opts: QuickActionOptions) {
  return {
    url: opts.url,
    userAgent: DEFAULT_USER_AGENT,
    gotoOptions: { ...X_GOTO_OPTIONS },
    rejectRequestPattern: [...REJECT_REQUEST_PATTERNS],
    // §7.4 Level 3 is not available inside a Quick Action, so `bestAttempt` is
    // what keeps a partially rendered page usable instead of failing outright.
    bestAttempt: true,
    actionTimeout: 30_000,
    ...(opts.formats?.length ? { formats: opts.formats } : {}),
    ...(opts.cookies?.length ? { cookies: opts.cookies } : {}),
  };
}

/**
 * The binding's overloads are keyed on the literal action name, so the calls are
 * written out rather than dispatched through a variable.
 */
async function invoke(env: Env, action: QuickAction, opts: QuickActionOptions): Promise<Response> {
  const base = buildOptions(opts) as BrowserRunMarkdownOptions;
  if (action === 'markdown') return env.BROWSER.quickAction('markdown', base);
  if (action === 'content') return env.BROWSER.quickAction('content', base);
  return env.BROWSER.quickAction('snapshot', base);
}

export async function runQuickAction<T = unknown>(
  env: Env,
  action: QuickAction,
  opts: QuickActionOptions,
): Promise<QuickActionResult<T>> {
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await invoke(env, action, opts);
  } catch (err) {
    // The binding itself can throw (RPC failure, remote mode not enabled).
    return {
      ok: false,
      status: 0,
      data: null,
      browserMsUsed: null,
      errorCode: 'FETCH_TIMEOUT',
      errorMessage: err instanceof Error ? err.message : String(err),
      rateLimited: false,
    };
  }

  const browserMsUsed = readBrowserMsUsed(response);
  const wallMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await safeText(response);
    const mapped = mapHttpFailure(action, response.status, body);
    log.warn('crawl_failed', {
      action,
      http_status: response.status,
      browser_ms_used: browserMsUsed ?? undefined,
      duration_ms: wallMs,
      error_code: mapped.errorCode,
      error_message: mapped.errorMessage,
    });
    return { ok: false, status: response.status, data: null, browserMsUsed, ...mapped };
  }

  const json = (await safeJson(response)) as { success?: boolean; result?: T; errors?: unknown } | null;

  // A 200 with success:false is still a failure, and carries its own code.
  if (!json || json.success === false) {
    const detail = json ? JSON.stringify(json.errors ?? json).slice(0, 500) : 'unparseable response';
    return {
      ok: false,
      status: response.status,
      data: null,
      browserMsUsed,
      errorCode: 'PAGE_BLOCKED',
      errorMessage: detail,
      rateLimited: detail.includes('2001') || detail.includes('Rate limit'),
    };
  }

  return {
    ok: true,
    status: response.status,
    data: json.result ?? null,
    browserMsUsed,
    errorCode: null,
    errorMessage: null,
    rateLimited: false,
  };
}

export interface SnapshotPayload {
  markdown: string | null;
  html: string | null;
  /** Base64 PNG, present only when the screenshot format was requested. */
  screenshotBase64: string | null;
}

/**
 * SPEC §7.1/§7.3 — one browser session, both artifacts.
 *
 * `result` is an object here, unlike the single-format endpoints, so the shape is
 * unwrapped here rather than in the caller.
 */
export async function runSnapshot(
  env: Env,
  opts: QuickActionOptions,
): Promise<QuickActionResult<SnapshotPayload> & { browserMsUsed: number | null }> {
  const result = await runQuickAction<Record<string, unknown>>(env, 'snapshot', opts);

  if (!result.ok) return { ...result, data: null };

  const body = result.data ?? {};
  const payload: SnapshotPayload = {
    markdown: typeof body.markdown === 'string' ? body.markdown : null,
    html: typeof body.content === 'string' ? body.content : null,
    screenshotBase64: typeof body.screenshot === 'string' ? body.screenshot : null,
  };

  // A snapshot with neither representation is a failure wearing a success status.
  if (!payload.markdown && !payload.html) {
    return {
      ...result,
      ok: false,
      data: null,
      errorCode: 'EMPTY_CONTENT',
      errorMessage: 'Browser Run snapshot returned neither Markdown nor HTML.',
    };
  }

  return { ...result, data: payload };
}

/** SPEC §35 — "Browser Run 会返回浏览器使用时长相关的响应头". */
function readBrowserMsUsed(response: Response): number | null {
  const raw = response.headers.get('x-browser-ms-used');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * SPEC §25 — distinct codes per failure mode. A 429 is separated out because it
 * means our own quota ran out, which needs a different backoff than a target that
 * is merely slow.
 */
function mapHttpFailure(
  action: string,
  status: number,
  body: string,
): { errorCode: CrawlErrorCode; errorMessage: string; rateLimited: boolean } {
  const detail = body.slice(0, 300);

  if (status === 429) {
    return {
      errorCode: 'PAGE_BLOCKED',
      errorMessage: `Browser Run rate limit reached (429) on ${action}. ${detail}`,
      rateLimited: true,
    };
  }
  if (status === 401 || status === 403) {
    return { errorCode: 'PAGE_BLOCKED', errorMessage: `${action} refused (${status}). ${detail}`, rateLimited: false };
  }
  if (status === 404 || status === 410) {
    return {
      errorCode: 'ARTICLE_NOT_FOUND',
      errorMessage: `${action} returned ${status} for the article. ${detail}`,
      rateLimited: false,
    };
  }
  // 2012 is Browser Run's own code for HTML-to-markdown conversion failure, and
  // 422 is what it returns for it: a conversion problem, not a fetch one.
  if (status === 422 || detail.includes('2012')) {
    return {
      errorCode: 'PARSER_FAILED',
      errorMessage: `Browser Run could not convert the page (${action}). ${detail}`,
      rateLimited: false,
    };
  }
  if (status === 408 || status === 504 || detail.includes('timeout')) {
    return {
      errorCode: 'FETCH_TIMEOUT',
      errorMessage: `${action} timed out loading the page. ${detail}`,
      rateLimited: false,
    };
  }

  return { errorCode: 'PAGE_BLOCKED', errorMessage: `${action} failed with ${status}. ${detail}`, rateLimited: false };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
