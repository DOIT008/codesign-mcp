// 统一重试策略：只对明确的瞬时故障重试，指数退避 + 抖动，尊重 Retry-After。
// 不重试 4xx（除 408/429），避免把参数错误或权限错误放大成长时间等待。

import { config } from '../config.js';
import { CodesignError } from '../codesign/errors.js';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

// Retry-After 支持 delta-seconds 与 HTTP-date 两种形式。
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  );
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof CodesignError && err.code === 'RATE_LIMITED') return true;
  return isNetworkError(err);
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError: unknown;
}

export interface WithRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  onRetry?: (ctx: RetryContext, delayMs: number) => void;
  // 由调用方提供：拿着 response 判断是否需要重试，需要时抛错。
  // 这样可以统一处理 Playwright / Node fetch 两种响应对象。
  retryOn?: (err: unknown, attempt: number) => number | undefined | false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(operation: () => Promise<T>, options: WithRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? config.retryMaxAttempts;
  const baseDelayMs = options.baseDelayMs ?? config.retryBaseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? config.retryMaxDelayMs;
  const retryAfterMaxMs = options.retryAfterMaxMs ?? config.retryAfterMaxMs;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;

      let delay: number | undefined;
      if (options.retryOn) {
        const hint = options.retryOn(err, attempt);
        if (hint === false) break;
        delay = hint;
      } else if (isRetryableError(err)) {
        delay =
          err instanceof CodesignError && err.code === 'RATE_LIMITED'
            ? (err.details?.retryAfterMs as number | undefined)
            : undefined;
      } else {
        break;
      }

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const resolved = delay != null
        ? Math.min(retryAfterMaxMs, delay)
        : Math.min(maxDelayMs, exponential + exponential * 0.25 * jitter());
      options.onRetry?.({ attempt, maxAttempts, lastError: err }, resolved);
      await sleep(resolved);
    }
  }
  throw lastError;
}

// 把重试耗尽的瞬时故障统一转成对 LLM 友好的错误码。
export function rateLimitError(scope: string, status: number | undefined, retryAfterMs?: number): CodesignError {
  return new CodesignError('RATE_LIMITED', `${scope} request failed with retryable status ${status ?? 'unknown'}`, {
    scope,
    status,
    retryAfterMs,
    suggestion: 'Wait and retry, or lower CODESIGN_API_RPS / CODESIGN_CDN_RPS.',
  });
}

// 三处请求入口共用：遇到 408/429/5xx 抛 RATE_LIMITED，交给 withRetry 处理。
export function assertNotRateLimited(
  status: number,
  scope: string,
  retryAfterHeader: string | null | undefined,
): void {
  if (!isRetryableStatus(status)) return;
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  throw rateLimitError(scope, status, retryAfterMs);
}
